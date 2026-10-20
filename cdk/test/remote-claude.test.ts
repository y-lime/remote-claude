import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Egress } from '../lib/config';
import { RemoteClaudeStack } from '../lib/remote-claude-stack';

function synth(egress: Egress): Template {
  const app = new cdk.App();
  const stack = new RemoteClaudeStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
    config: { egress, instanceType: 't3.large', volumeSizeGiB: 100, sshPublicKey: 'ssh-ed25519 AAAA test',
      claudeModel: 'opus', claudeOpusModel: 'global.anthropic.claude-opus-4-6-v1',
      claudeSonnetModel: 'jp.anthropic.claude-sonnet-4-6', claudeHaikuModel: 'jp.anthropic.claude-haiku-4-5-20251001-v1:0' },
  });
  return Template.fromStack(stack);
}

describe.each<Egress>(['nat', 'public', 'isolated'])('egress=%s', (egress) => {
  const template = synth(egress);

  test('インスタンスの SG にインバウンドがない', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'remote-claude instance (no inbound)',
      SecurityGroupIngress: Match.absent(),
    });
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });

  test('IMDSv2 必須、ホップ数 2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: {
        MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
      },
    });
  });

  test('NAT とエンドポイントの数', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', egress === 'nat' ? 1 : 0);
    // インターフェース4本 + S3 ゲートウェイ1本
    template.resourceCountIs('AWS::EC2::VPCEndpoint', egress === 'public' ? 1 : 5);
  });

  test('ルート EBS は暗号化された gp3', () => {
    template.hasResourceProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: [{
        DeviceName: '/dev/xvda',
        Ebs: { VolumeSize: 100, VolumeType: 'gp3', Encrypted: true },
      }],
    });
  });
});

test('user data で Claude Code を入れ、Bedrock の設定をする', () => {
  const instance = Object.values(synth('nat').findResources('AWS::EC2::Instance'))[0];
  const userData: string = instance.Properties.UserData['Fn::Base64'];
  expect(userData).toContain('https://claude.ai/install.sh');
  expect(userData).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=global.anthropic.claude-opus-4-6-v1');
  expect(userData).toContain('nodejs24-npm');
  expect(userData).toContain('AWS_REGION=ap-northeast-1');
  expect(userData).not.toMatch(/__[A-Z_]+__/);
});
