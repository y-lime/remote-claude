# remote-claude

ローカルから透過的に扱えるリモートの Claude Code 実行環境。

- [cdk/](cdk/README.md)：AWS 上の実行環境（EC2 1台）を作る CDK
- [scripts/](scripts/)：手元の Windows から EC2 を起動、停止、接続するスクリプト
- [devcontainer-template/](devcontainer-template/README.md)：EC2 上で動かす devcontainer のひな形（Java 25、Gradle、Claude Code）

## 手元からの操作（`scripts\remote.cmd`）

AWS CLI v2 と Session Manager Plugin が入っていて、`aws sso login` などで認証済みであることが前提。

```powershell
scripts\remote.cmd start        # 起動し、SSM で接続できるようになるまで待つ
scripts\remote.cmd stop         # 停止する
scripts\remote.cmd status       # 状態を表示する（EC2 と SSM Agent）
scripts\remote.cmd shell        # 止まっていたら起動して、SSM で ec2-user のシェルを開く
scripts\remote.cmd tmux [名前]  # shell と同じだが、tmux のセッションに入る（既定 main。なければ作る。切断しても作業が続く）
scripts\remote.cmd ssh          # 止まっていたら起動して、ssh remote-claude で接続する
scripts\remote.cmd ssh-config   # ~/.ssh/config に追記する設定を表示する
```

開発は devcontainer の中で行う（EC2 のホストには Claude Code、Java、Gradle を入れない）。VS Code の拡張機能（Remote-SSH、Dev Containers）がなくても、`tmux` で入って devcontainer CLI でコンテナに入れば作業できる（[devcontainer-template/](devcontainer-template/README.md#vs-code-の拡張機能なしで使うdevcontainer-cli)）。ウィンドウを閉じても処理は続く。次に `scripts\remote.cmd tmux` を実行すると同じ画面に戻る（tmux の中から抜けるときは `Ctrl-b d`）。

接続がなく、Claude Code も作業していない状態が30分続くと、EC2 は自分で停止する。tmux で Claude Code に作業させたまま接続を切っても、作業が終わるまでは止まらない（[cdk/README](cdk/README.md#使っていないときの自動停止)）。

インスタンス ID は CloudFormation スタック（`RemoteClaudeStack`）の出力から取る。リージョン、スタック名、インスタンス ID は環境変数 `REMOTE_CLAUDE_REGION`、`REMOTE_CLAUDE_STACK`、`REMOTE_CLAUDE_INSTANCE_ID` で上書きできる。

### 接続時に自動で起動する

`scripts\remote.cmd ssh-config` の出力を `~/.ssh/config` に追記する。ProxyCommand がこのスクリプトを呼ぶので、`ssh remote-claude` を実行したときや VS Code の Remote-SSH で接続したときに、インスタンスが止まっていれば自動で起動してから接続する。

起動には1〜2分かかる。VS Code の Remote-SSH は既定で15秒でタイムアウトするので、VS Code の設定で延ばしておく。

```json
"remote.SSH.connectTimeout": 300
```

### 必要な IAM 権限（手元の利用者）

`ec2:DescribeInstances`、`ec2:StartInstances`、`ec2:StopInstances`、`ssm:DescribeInstanceInformation`、`ssm:StartSession`（`AWS-StartSSHSession` と `AWS-StartInteractiveCommand` ドキュメント、対象インスタンス）、`cloudformation:DescribeStacks`
