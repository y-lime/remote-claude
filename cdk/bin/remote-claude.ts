#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ArtifactsStack } from '../lib/artifacts-stack';
import { RemoteClaudeBaseStack } from '../lib/base-stack';
import { loadConfig } from '../lib/config';
import { RemoteClaudeInstanceStack } from '../lib/instance-stack';

const app = new cdk.App();
const config = loadConfig(app.node);
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: app.node.tryGetContext('region') ?? 'ap-northeast-1',
};

// EC2 のスタックとはエクスポートでつながず名前だけを渡す。どちらを消すときも、もう片方が邪魔をしない
if (config.codeArtifactCreate) {
  new ArtifactsStack(app, 'RemoteClaudeArtifactsStack', {
    env,
    domainName: config.codeArtifactDomain,
    repositoryName: config.codeArtifactRepository,
    description: 'CodeArtifact for remote-claude (Maven Central / Gradle Plugin Portal upstreams)',
  });
}

const base = new RemoteClaudeBaseStack(app, 'RemoteClaudeBaseStack', {
  env,
  config,
  description: 'Remote Claude Code environment: shared network, role and member policy (SSM, no inbound)',
});

// メンバーごとに1スタック。cdk.json の instances から消してもスタックは残るので、cdk destroy RemoteClaude-<name> で消す
for (const instance of config.instances) {
  new RemoteClaudeInstanceStack(app, `RemoteClaude-${instance.name}`, {
    env,
    config,
    instance,
    base,
    description: `Remote Claude Code environment for ${instance.name} (EC2)`,
  });
}
