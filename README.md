# remote-claude

ローカルから透過的に扱えるリモートの Claude Code 実行環境。

- [cdk/](cdk/README.md)：AWS 上の実行環境（EC2 1台）を作る CDK
- [scripts/](scripts/)：手元の Windows から EC2 を起動、停止、接続するスクリプト

## 手元からの操作（`scripts\remote.cmd`）

AWS CLI v2 と Session Manager Plugin が入っていて、`aws sso login` などで認証済みであることが前提。

```powershell
scripts\remote.cmd start        # 起動し、SSM で接続できるようになるまで待つ
scripts\remote.cmd stop         # 停止する
scripts\remote.cmd status       # 状態を表示する（EC2 と SSM Agent）
scripts\remote.cmd shell        # 止まっていたら起動して、SSM で ec2-user のシェルを開く
scripts\remote.cmd ssh          # 止まっていたら起動して、ssh remote-claude で接続する
scripts\remote.cmd ssh-config   # ~/.ssh/config に追記する設定を表示する
```

インスタンス ID は CloudFormation スタック（`RemoteClaudeStack`）の出力から取る。リージョン、スタック名、インスタンス ID は環境変数 `REMOTE_CLAUDE_REGION`、`REMOTE_CLAUDE_STACK`、`REMOTE_CLAUDE_INSTANCE_ID` で上書きできる。

### 接続時に自動で起動する

`scripts\remote.cmd ssh-config` の出力を `~/.ssh/config` に追記する。ProxyCommand がこのスクリプトを呼ぶので、`ssh remote-claude` を実行したときや VS Code の Remote-SSH で接続したときに、インスタンスが止まっていれば自動で起動してから接続する。

起動には1〜2分かかる。VS Code の Remote-SSH は既定で15秒でタイムアウトするので、VS Code の設定で延ばしておく。

```json
"remote.SSH.connectTimeout": 300
```

### 必要な IAM 権限（手元の利用者）

`ec2:DescribeInstances`、`ec2:StartInstances`、`ec2:StopInstances`、`ssm:DescribeInstanceInformation`、`ssm:StartSession`（`AWS-StartSSHSession` ドキュメントと対象インスタンス）、`cloudformation:DescribeStacks`
