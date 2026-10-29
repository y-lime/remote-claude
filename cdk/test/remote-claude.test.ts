import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ArtifactsStack } from '../lib/artifacts-stack';
import { Egress, loadConfig, RemoteClaudeConfig } from '../lib/config';
import { RemoteClaudeStack } from '../lib/remote-claude-stack';

const env = { account: '123456789012', region: 'ap-northeast-1' };

function synth(egress: Egress): Template {
  const app = new cdk.App();
  const config: RemoteClaudeConfig = {
    ...loadConfig(app.node),
    egress, sshPublicKey: 'ssh-ed25519 AAAA test',
  };
  return Template.fromStack(new RemoteClaudeStack(app, 'TestStack', { env, config }));
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

describe('user data', () => {
  const instance = Object.values(synth('nat').findResources('AWS::EC2::Instance'))[0];
  const userData: string = instance.Properties.UserData['Fn::Base64'];

  test('Docker と devcontainer CLI を入れる', () => {
    expect(userData).toContain('dnf install -y docker');
    expect(userData).toContain('"max-size": "10m"');
    expect(userData).toContain('npm install -g @devcontainers/cli');
  });

  test('devcontainer-template のベースイメージを先に取っておく', () => {
    const devcontainerJson = fs.readFileSync(
      path.join(__dirname, '..', '..', 'devcontainer-template', '.devcontainer', 'devcontainer.json'), 'utf8');
    const image = devcontainerJson.match(/"image":\s*"([^"]+)"/)![1];
    expect(userData).toContain(`docker pull ${image}`);
  });

  test('開発ツールはホストに入れない（devcontainer の中で使う）', () => {
    expect(userData).not.toContain('https://claude.ai/install.sh');
    expect(userData).not.toContain('amazon-corretto');
    expect(userData).not.toContain('services.gradle.org');
  });

  test('devcontainer に渡す Bedrock と CodeArtifact の設定を置く', () => {
    expect(userData).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL=global.anthropic.claude-opus-4-6-v1');
    expect(userData).toContain('AWS_REGION=ap-northeast-1');
    expect(userData).toContain(
      'CODEARTIFACT_URL=https://remote-claude-123456789012.d.codeartifact.ap-northeast-1.amazonaws.com/maven/libs/');
    expect(userData).toContain('"get-authorization-token"');
  });

  test('使っていなければ停止する', () => {
    expect(userData).toContain('IDLE_STOP_MINUTES=30');
    expect(userData).toContain('systemctl enable --now remote-claude-idle-stop.timer');
    expect(userData).toContain('/etc/remote-claude/claude-code/managed-settings.json');
    expect(instance.Properties.InstanceInitiatedShutdownBehavior).toBe('stop');
  });

  test('devcontainer-template が hook と書き込み先をマウントする', () => {
    const devcontainerJson = fs.readFileSync(
      path.join(__dirname, '..', '..', 'devcontainer-template', '.devcontainer', 'devcontainer.json'), 'utf8');
    expect(devcontainerJson).toContain('source=/etc/remote-claude/claude-code,target=/etc/claude-code');
    expect(devcontainerJson).toContain('source=/run/remote-claude/claude-activity,target=/run/remote-claude/claude-activity');
  });

  test('プレースホルダーが残っていない', () => {
    expect(userData).not.toMatch(/__[A-Z_]+__/);
  });
});

test('IAM ロールは CodeArtifact を読むだけ', () => {
  const template = synth('nat');
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: 'CodeArtifactRead',
          Action: ['codeartifact:GetRepositoryEndpoint', 'codeartifact:ReadFromRepository'],
        }),
        Match.objectLike({
          Sid: 'CodeArtifactBearerToken',
          Condition: { StringEquals: { 'sts:AWSServiceName': 'codeartifact.amazonaws.com' } },
        }),
      ]),
    },
  });
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
  expect(policies).not.toContain('codeartifact:PublishPackageVersion');
});

describe('CodeArtifact', () => {
  const app = new cdk.App();
  const template = Template.fromStack(new ArtifactsStack(app, 'Artifacts', {
    env, domainName: 'remote-claude', repositoryName: 'libs',
  }));

  test('Maven Central と Gradle Plugin Portal を上流にした libs', () => {
    template.resourceCountIs('AWS::CodeArtifact::Repository', 3);
    template.hasResourceProperties('AWS::CodeArtifact::Repository', {
      RepositoryName: 'maven-central-store', ExternalConnections: ['public:maven-central'],
    });
    template.hasResourceProperties('AWS::CodeArtifact::Repository', {
      RepositoryName: 'gradle-plugins-store', ExternalConnections: ['public:maven-gradleplugins'],
    });
    template.hasResourceProperties('AWS::CodeArtifact::Repository', {
      RepositoryName: 'libs',
      Upstreams: [
        { 'Fn::GetAtt': [Match.stringLikeRegexp('^MavenCentralStore'), 'Name'] },
        { 'Fn::GetAtt': [Match.stringLikeRegexp('^GradlePluginsStore'), 'Name'] },
      ],
    });
  });

  test('ドメインとリポジトリは消さない', () => {
    for (const type of ['AWS::CodeArtifact::Domain', 'AWS::CodeArtifact::Repository']) {
      for (const res of Object.values(template.findResources(type))) {
        expect(res.DeletionPolicy).toBe('Retain');
      }
    }
  });
});

test('idleStopMinutes は 0 以上の整数', () => {
  expect(loadConfig(new cdk.App({ context: { idleStopMinutes: '0' } }).node).idleStopMinutes).toBe(0);
  expect(() => loadConfig(new cdk.App({ context: { idleStopMinutes: 'abc' } }).node)).toThrow();
  expect(() => loadConfig(new cdk.App({ context: { idleStopMinutes: -1 } }).node)).toThrow();
});

test('-c codeArtifactCreate=false を読める', () => {
  const app = new cdk.App({ context: { codeArtifactCreate: 'false' } });
  expect(loadConfig(app.node).codeArtifactCreate).toBe(false);
  expect(loadConfig(new cdk.App().node).codeArtifactCreate).toBe(true);
});
