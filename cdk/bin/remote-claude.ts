#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { loadConfig } from '../lib/config';
import { RemoteClaudeStack } from '../lib/remote-claude-stack';

const app = new cdk.App();
const config = loadConfig(app.node);

new RemoteClaudeStack(app, 'RemoteClaudeStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: app.node.tryGetContext('region') ?? 'ap-northeast-1',
  },
  config,
  description: 'Remote Claude Code environment (EC2 + SSM, no inbound)',
});
