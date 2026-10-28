import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RemoteClaudeConfig } from './config';

export interface RemoteClaudeStackProps extends cdk.StackProps {
  readonly config: RemoteClaudeConfig;
}

/**
 * Claude Code を常駐させる EC2 1台と、そのネットワーク。
 * 接続は SSM Session Manager（SSH over SSM）だけで、インバウンドは全閉。
 */
export class RemoteClaudeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RemoteClaudeStackProps) {
    super(scope, id, props);
    const { config } = props;

    // ---- ネットワーク ----
    const instanceSubnetType = {
      nat: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      public: ec2.SubnetType.PUBLIC,
      isolated: ec2.SubnetType.PRIVATE_ISOLATED,
    }[config.egress];

    const subnetConfiguration: ec2.SubnetConfiguration[] = [];
    if (config.egress !== 'isolated') {
      subnetConfiguration.push({ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 });
    }
    if (config.egress !== 'public') {
      subnetConfiguration.push({ name: 'private', subnetType: instanceSubnetType, cidrMask: 24 });
    }

    // 1台だけなので AZ も1つ（NAT とエンドポイントの料金を AZ 数ぶん払わないため）
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

    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSg', {
      vpc,
      description: 'remote-claude instance (no inbound)',
      allowAllOutbound: true,
    });

    // ---- IAM ----
    const role = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
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

    // ---- EC2 ----
    const asset = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'assets', name), 'utf8');
    const caUrl = `https://${config.codeArtifactDomain}-${caOwner}.d.codeartifact.${this.region}.amazonaws.com`
      + `/maven/${config.codeArtifactRepository}/`;
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      [asset('user-data.sh'), asset('setup-devcontainer.sh')].join('\n')
        .replaceAll('__SSH_PUBLIC_KEY__', config.sshPublicKey ?? '')
        .replaceAll('__AWS_REGION__', this.region)
        .replaceAll('__CLAUDE_MODEL__', config.claudeModel)
        .replaceAll('__CLAUDE_OPUS_MODEL__', config.claudeOpusModel)
        .replaceAll('__CLAUDE_SONNET_MODEL__', config.claudeSonnetModel)
        .replaceAll('__CLAUDE_HAIKU_MODEL__', config.claudeHaikuModel)
        .replaceAll('__CODEARTIFACT_DOMAIN__', config.codeArtifactDomain)
        .replaceAll('__CODEARTIFACT_DOMAIN_OWNER__', caOwner)
        .replaceAll('__CODEARTIFACT_URL__', caUrl)
        // 置換文字列の $ を特殊文字として扱わせないため関数で渡す
        .replaceAll('__GRADLE_INIT_SCRIPT__', () => asset('codeartifact.init.gradle.kts').trimEnd()),
    );
    if (!config.sshPublicKey) {
      cdk.Annotations.of(this).addWarningV2('remote-claude:no-ssh-key',
        'sshPublicKeyPath の公開鍵が見つからないため、authorized_keys に登録しません（SSH over SSM で接続できません）');
    }

    const instance = new ec2.Instance(this, 'Instance', {
      vpc,
      vpcSubnets: { subnetType: instanceSubnetType },
      securityGroup,
      role,
      instanceType: new ec2.InstanceType(config.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData,
      // user data は初回起動時にしか実行されないので、変えたらインスタンスごと作り直す（EBS も消える）
      userDataCausesReplacement: true,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(config.volumeSizeGiB, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
        }),
      }],
    });
    cdk.Tags.of(instance).add('Name', 'remote-claude');

    // IMDSv2 を必須にしつつ、ホップ数を 2 にして devcontainer（ブリッジネットワーク）からもロールの認証情報を取れるようにする
    const metadataTemplate = new ec2.LaunchTemplate(this, 'MetadataOptions', {
      requireImdsv2: true,
      httpPutResponseHopLimit: 2,
    });
    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.launchTemplate = {
      launchTemplateId: metadataTemplate.launchTemplateId,
      version: metadataTemplate.latestVersionNumber,
    };

    // ---- 出力 ----
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'Egress', { value: config.egress });
    new cdk.CfnOutput(this, 'SsmStartSession', {
      value: `aws ssm start-session --region ${this.region} --target ${instance.instanceId}`,
    });
  }
}
