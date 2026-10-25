#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ArtifactsStack } from '../lib/artifacts-stack';
import { loadConfig } from '../lib/config';
import { RemoteClaudeStack } from '../lib/remote-claude-stack';

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

new RemoteClaudeStack(app, 'RemoteClaudeStack', {
  env,
  config,
  description: 'Remote Claude Code environment (EC2 + SSM, no inbound)',
});
