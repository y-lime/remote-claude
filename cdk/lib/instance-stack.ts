import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { MANAGED_TAG_KEY, MANAGED_TAG_VALUE, RemoteClaudeBaseStack } from './base-stack';
import { InstanceConfig, RemoteClaudeConfig } from './config';

export interface RemoteClaudeInstanceStackProps extends cdk.StackProps {
  readonly config: RemoteClaudeConfig;
  readonly instance: InstanceConfig;
  readonly base: RemoteClaudeBaseStack;
}

/**
 * メンバー1人ぶんの、Claude Code を常駐させる EC2。ネットワークとロールは RemoteClaudeBaseStack のものを使う。
 * スタックごと消せばそのメンバーの EC2 だけが消える。
 */
export class RemoteClaudeInstanceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: RemoteClaudeInstanceStackProps) {
    super(scope, id, props);
    const { config, instance: member, base } = props;

    const asset = (name: string) => fs.readFileSync(path.join(__dirname, '..', 'assets', name), 'utf8');
    const caOwner = config.codeArtifactDomainOwner ?? this.account;
    const caUrl = `https://${config.codeArtifactDomain}-${caOwner}.d.codeartifact.${this.region}.amazonaws.com`
      + `/maven/${config.codeArtifactRepository}/`;
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      [asset('user-data.sh'), asset('setup-devcontainer.sh'), asset('setup-idle-stop.sh')].join('\n')
        .replaceAll('__SSH_PUBLIC_KEY__', member.sshPublicKey ?? '')
        .replaceAll('__AWS_REGION__', this.region)
        .replaceAll('__CLAUDE_MODEL__', config.claudeModel)
        .replaceAll('__CLAUDE_OPUS_MODEL__', config.claudeOpusModel)
        .replaceAll('__CLAUDE_SONNET_MODEL__', config.claudeSonnetModel)
        .replaceAll('__CLAUDE_HAIKU_MODEL__', config.claudeHaikuModel)
        .replaceAll('__CODEARTIFACT_DOMAIN__', config.codeArtifactDomain)
        .replaceAll('__CODEARTIFACT_DOMAIN_OWNER__', caOwner)
        .replaceAll('__CODEARTIFACT_URL__', caUrl)
        .replaceAll('__IDLE_STOP_MINUTES__', String(config.idleStopMinutes))
        // 置換文字列の $ を特殊文字として扱わせないため関数で渡す
        .replaceAll('__GRADLE_INIT_SCRIPT__', () => asset('codeartifact.init.gradle.kts').trimEnd()),
    );
    if (!member.sshPublicKey) {
      cdk.Annotations.of(this).addWarningV2('remote-claude:no-ssh-key',
        `${member.name} の公開鍵がないため、authorized_keys に登録しません（SSH over SSM で接続できません。shell と tmux は使えます）`);
    }

    const instance = new ec2.Instance(this, 'Instance', {
      vpc: base.vpc,
      vpcSubnets: { subnetType: base.instanceSubnetType },
      securityGroup: base.securityGroup,
      role: base.role,
      instanceType: new ec2.InstanceType(member.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      userData,
      // user data は初回起動時にしか実行されないので、変えたらインスタンスごと作り直す（EBS も消える）
      userDataCausesReplacement: true,
      // 使っていないときに中から止める（assets/setup-idle-stop.sh）ので、シャットダウンは終了ではなく停止にする
      instanceInitiatedShutdownBehavior: ec2.InstanceInitiatedShutdownBehavior.STOP,
      blockDevices: [{
        deviceName: '/dev/xvda',
        volume: ec2.BlockDeviceVolume.ebs(member.volumeSizeGiB, {
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          encrypted: true,
        }),
      }],
    });
    cdk.Tags.of(instance).add('Name', `remote-claude-${member.name}`);
    cdk.Tags.of(instance).add(MANAGED_TAG_KEY, MANAGED_TAG_VALUE);

    // IMDSv2 必須、ホップ数 2 の起動テンプレート（RemoteClaudeBaseStack）を使う
    const cfnInstance = instance.node.defaultChild as ec2.CfnInstance;
    cfnInstance.launchTemplate = {
      launchTemplateId: base.launchTemplate.launchTemplateId,
      version: base.launchTemplate.latestVersionNumber,
    };

    // ---- 出力（scripts/make-kits.ts が読む） ----
    new cdk.CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new cdk.CfnOutput(this, 'MemberName', { value: member.name });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
    new cdk.CfnOutput(this, 'IdleStopMinutes', { value: String(config.idleStopMinutes) });
    new cdk.CfnOutput(this, 'SsmStartSession', {
      value: `aws ssm start-session --region ${this.region} --target ${instance.instanceId}`,
    });
  }
}
