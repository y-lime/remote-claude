import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RemoteClaudeConfig } from './config';

/** メンバーが接続、起動、停止してよいインスタンスに付けるタグ */
export const MANAGED_TAG_KEY = 'remote-claude:managed';
export const MANAGED_TAG_VALUE = 'true';

export interface RemoteClaudeBaseStackProps extends cdk.StackProps {
  readonly config: RemoteClaudeConfig;
}

/**
 * メンバー全員の EC2 で共有するもの（ネットワーク、インスタンスロール、起動テンプレート、メンバー用ポリシー）。
 * NAT と VPC エンドポイントを人数ぶん払わないよう、EC2 とは別のスタックにして1つだけ作る。
 * 接続は SSM Session Manager（SSH over SSM）だけで、インバウンドは全閉。
 */
export class RemoteClaudeBaseStack extends cdk.Stack {
  readonly vpc: ec2.IVpc;
  readonly instanceSubnetType: ec2.SubnetType;
  readonly securityGroup: ec2.ISecurityGroup;
  readonly role: iam.IRole;
  readonly launchTemplate: ec2.LaunchTemplate;

  constructor(scope: Construct, id: string, props: RemoteClaudeBaseStackProps) {
    super(scope, id, props);
    const { config } = props;

    // ---- ネットワーク ----
    const instanceSubnetType = {
      nat: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      public: ec2.SubnetType.PUBLIC,
      isolated: ec2.SubnetType.PRIVATE_ISOLATED,
    }[config.egress];
    this.instanceSubnetType = instanceSubnetType;

    const subnetConfiguration: ec2.SubnetConfiguration[] = [];
    if (config.egress !== 'isolated') {
      subnetConfiguration.push({ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 });
    }
    if (config.egress !== 'public') {
      subnetConfiguration.push({ name: 'private', subnetType: instanceSubnetType, cidrMask: 24 });
    }

    // AZ は1つ（NAT とエンドポイントの料金を AZ 数ぶん払わないため）
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.80.0.0/16'),
      maxAzs: 1,
      natGateways: config.egress === 'nat' ? 1 : 0,
      subnetConfiguration,
      gatewayEndpoints: {
        // dnf のリポジトリは S3 上にあるので、閉域でもパッケージを入れられる（無料）
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });
    this.vpc = vpc;

    if (config.egress !== 'public') {
      const endpoints: Record<string, ec2.InterfaceVpcEndpointAwsService> = {
        Ssm: ec2.InterfaceVpcEndpointAwsService.SSM,
        SsmMessages: ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES,
        Ec2Messages: ec2.InterfaceVpcEndpointAwsService.EC2_MESSAGES,
        BedrockRuntime: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME,
      };
      for (const [name, service] of Object.entries(endpoints)) {
        vpc.addInterfaceEndpoint(name, { service, subnets: { subnetType: instanceSubnetType } });
      }
    }

    this.securityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'remote-claude instance (no inbound)',
      allowAllOutbound: true,
    });

    // ---- インスタンスロール ----
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    this.role = role;
    // クロスリージョン推論プロファイルは他リージョンのモデルを呼ぶので、リージョンは * にする
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'InvokeClaudeOnBedrock',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: [
        'arn:aws:bedrock:*::foundation-model/anthropic.*',
        `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
        `arn:aws:bedrock:*:${this.account}:application-inference-profile/*`,
      ],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'ListBedrockProfiles',
      actions: ['bedrock:ListInferenceProfiles', 'bedrock:GetInferenceProfile', 'bedrock:ListFoundationModels'],
      resources: ['*'],
    }));

    // CodeArtifact は読み取りだけ。publish は手元からユーザー自身の権限で行う
    const caOwner = config.codeArtifactDomainOwner ?? this.account;
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'CodeArtifactToken',
      actions: ['codeartifact:GetAuthorizationToken'],
      resources: [`arn:aws:codeartifact:${this.region}:${caOwner}:domain/${config.codeArtifactDomain}`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'CodeArtifactRead',
      actions: ['codeartifact:GetRepositoryEndpoint', 'codeartifact:ReadFromRepository'],
      resources: [`arn:aws:codeartifact:${this.region}:${caOwner}:repository/${config.codeArtifactDomain}/*`],
    }));
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'CodeArtifactBearerToken',
      actions: ['sts:GetServiceBearerToken'],
      resources: ['*'],
      conditions: { StringEquals: { 'sts:AWSServiceName': 'codeartifact.amazonaws.com' } },
    }));

    // IMDSv2 を必須にしつつ、ホップ数を 2 にして devcontainer（ブリッジネットワーク）からもロールの認証情報を取れるようにする
    this.launchTemplate = new ec2.LaunchTemplate(this, 'MetadataOptions', {
      requireImdsv2: true,
      httpPutResponseHopLimit: 2,
    });

    // ---- メンバー用ポリシー ----
    // チーム内で使うので、どのメンバーの EC2 にも入れてよい（タグの付いたインスタンスに限る）
    const managedTag = { [`aws:ResourceTag/${MANAGED_TAG_KEY}`]: MANAGED_TAG_VALUE };
    const userPolicy = new iam.ManagedPolicy(this, 'UserPolicy', {
      managedPolicyName: 'RemoteClaudeUser',
      description: 'remote-claude の EC2 を起動、停止し、SSM で接続する（scripts/remote.ps1）',
      statements: [
        new iam.PolicyStatement({
          sid: 'Describe',
          actions: ['ec2:DescribeInstances', 'ssm:DescribeInstanceInformation'],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          sid: 'StartStopInstances',
          actions: ['ec2:StartInstances', 'ec2:StopInstances'],
          resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
          conditions: { StringEquals: managedTag },
        }),
        new iam.PolicyStatement({
          sid: 'StartSessionOnInstances',
          actions: ['ssm:StartSession'],
          resources: [`arn:aws:ec2:${this.region}:${this.account}:instance/*`],
          conditions: { StringEquals: managedTag },
        }),
        new iam.PolicyStatement({
          sid: 'StartSessionDocuments',
          actions: ['ssm:StartSession'],
          resources: ['AWS-StartSSHSession', 'AWS-StartInteractiveCommand']
            .map((doc) => `arn:aws:ssm:${this.region}::document/${doc}`),
        }),
        new iam.PolicyStatement({
          sid: 'OwnSessions',
          actions: ['ssm:TerminateSession', 'ssm:ResumeSession'],
          resources: [`arn:aws:ssm:${this.region}:${this.account}:session/\${aws:username}-*`],
        }),
      ],
    });
    const iamUsers = [...new Set(config.instances.flatMap((i) => (i.iamUser ? [i.iamUser] : [])))];
    for (const userName of iamUsers) {
      userPolicy.attachToUser(iam.User.fromUserName(this, `Member-${userName}`, userName));
    }

    new cdk.CfnOutput(this, 'Egress', { value: config.egress });
    new cdk.CfnOutput(this, 'UserPolicyName', { value: userPolicy.managedPolicyName });
  }
}
