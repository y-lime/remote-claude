import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ArtifactsStack } from '../lib/artifacts-stack';
import { RemoteClaudeBaseStack } from '../lib/base-stack';
import { Egress, loadConfig, RemoteClaudeConfig } from '../lib/config';
import { RemoteClaudeInstanceStack } from '../lib/instance-stack';

const env = { account: '123456789012', region: 'ap-northeast-1' };

const INSTANCES = {
  alice: { iamUser: 'alice', sshPublicKey: 'ssh-ed25519 AAAA alice' },
  bob: { iamUser: 'bob', instanceType: 't3.xlarge' },
};

function synthAll(egress: Egress): { base: Template; instances: Template[] } {
  const app = new cdk.App({ context: { instances: INSTANCES } });
  const config: RemoteClaudeConfig = { ...loadConfig(app.node), egress };
  const base = new RemoteClaudeBaseStack(app, 'Base', { env, config });
  const instances = config.instances.map((instance) =>
    new RemoteClaudeInstanceStack(app, `RemoteClaude-${instance.name}`, { env, config, instance, base }));
  return { base: Template.fromStack(base), instances: instances.map((s) => Template.fromStack(s)) };
}

describe.each<Egress>(['nat', 'public', 'isolated'])('egress=%s', (egress) => {
  const { base, instances: [template] } = synthAll(egress);

  test('インスタンスの SG にインバウンドがない', () => {
    base.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'remote-claude instance (no inbound)',
      SecurityGroupIngress: Match.absent(),
    });
    base.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
    template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 0);
  });

  test('IMDSv2 必須、ホップ数 2', () => {
    base.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: {
        MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 2 },
      },
    });
    template.hasResourceProperties('AWS::EC2::Instance', { LaunchTemplate: Match.objectLike({}) });
  });

  test('NAT とエンドポイントの数', () => {
    base.resourceCountIs('AWS::EC2::NatGateway', egress === 'nat' ? 1 : 0);
    // インターフェース4本 + S3 ゲートウェイ1本
    base.resourceCountIs('AWS::EC2::VPCEndpoint', egress === 'public' ? 1 : 5);
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

describe('メンバーごとの EC2', () => {
  const { base, instances } = synthAll('nat');

  test('ネットワークは共有し、EC2 だけ人数ぶん作る', () => {
    base.resourceCountIs('AWS::EC2::VPC', 1);
    base.resourceCountIs('AWS::EC2::Instance', 0);
    expect(instances).toHaveLength(2);
    for (const t of instances) {
      t.resourceCountIs('AWS::EC2::Instance', 1);
      t.resourceCountIs('AWS::EC2::VPC', 0);
      t.resourceCountIs('AWS::EC2::NatGateway', 0);
    }
  });

  test('名前とメンバー用ポリシーのタグを付ける', () => {
    instances[0].hasResourceProperties('AWS::EC2::Instance', {
      Tags: Match.arrayWith([
        { Key: 'Name', Value: 'remote-claude-alice' },
        { Key: 'remote-claude:managed', Value: 'true' },
      ]),
    });
    instances[0].hasOutput('MemberName', { Value: 'alice' });
  });

  test('個別の instanceType で上書きできる', () => {
    instances[0].hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't3.large' });
    instances[1].hasResourceProperties('AWS::EC2::Instance', { InstanceType: 't3.xlarge' });
  });

  test('公開鍵はそのメンバーの EC2 にだけ入る', () => {
    const userData = (t: Template) =>
      JSON.stringify(Object.values(t.findResources('AWS::EC2::Instance'))[0].Properties.UserData);
    expect(userData(instances[0])).toContain('ssh-ed25519 AAAA alice');
    expect(userData(instances[1])).not.toContain('ssh-ed25519');
  });

  test('RemoteClaudeUser を iamUser に付け、タグの付いたインスタンスにだけ接続させる', () => {
    base.hasResourceProperties('AWS::IAM::ManagedPolicy', {
      ManagedPolicyName: 'RemoteClaudeUser',
      Users: ['alice', 'bob'],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'StartStopInstances',
            Condition: { StringEquals: { 'aws:ResourceTag/remote-claude:managed': 'true' } },
          }),
          Match.objectLike({
            Sid: 'StartSessionOnInstances',
            Action: 'ssm:StartSession',
            Condition: { StringEquals: { 'aws:ResourceTag/remote-claude:managed': 'true' } },
          }),
        ]),
      },
    });
  });
});

describe('user data', () => {
  const instance = Object.values(synthAll('nat').instances[0].findResources('AWS::EC2::Instance'))[0];
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
  const template = synthAll('nat').base;
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

test('instances の名前は英小文字、数字、- だけ', () => {
  expect(() => loadConfig(new cdk.App({ context: { instances: { Alice: {} } } }).node)).toThrow();
  expect(() => loadConfig(new cdk.App({ context: { instances: { 'a.b': {} } } }).node)).toThrow();
  const config = loadConfig(new cdk.App({ context: { instances: { 'team-a1': {} } } }).node);
  expect(config.instances).toEqual([
    { name: 'team-a1', iamUser: undefined, sshPublicKey: undefined, instanceType: 't3.large', volumeSizeGiB: 100 },
  ]);
});
