# remote-claude

ローカルから透過的に扱えるリモートの Claude Code 実行環境。

- [cdk/](cdk/README.md)：AWS 上の実行環境（メンバーごとに EC2 1台）を作る CDK
- [scripts/](scripts/)：手元の Windows から EC2 を起動、停止、接続するスクリプト
- [devcontainer-template/](devcontainer-template/README.md)：EC2 上で動かす devcontainer のひな形（Java 25、Gradle、Claude Code）

## メンバーに EC2 を配る

デプロイは管理する人の端末からだけ行い、メンバーには接続キット（zip）を渡す。

1. メンバーから IAM ユーザー名と、VS Code の Remote-SSH を使うなら SSH の公開鍵（`~/.ssh/id_ed25519.pub` の中身）をもらう。公開鍵はあとから足すと EC2 が作り直しになる
2. `cdk/cdk.json` の `instances` に追記する（名前は英小文字、数字、`-`）

   ```json
   "instances": {
     "ymura": { "sshPublicKeyPath": "~/.ssh/id_ed25519.pub" },
     "tanaka": { "iamUser": "tanaka", "sshPublicKey": "ssh-ed25519 AAAA... tanaka@pc" }
   }
   ```

3. `cd cdk; npm run deploy`。成功すると、全員分の接続キットが `kits/remote-claude-<名前>.zip` にできる（`npm run kits` で作り直しだけもできる）
4. zip をメンバーに渡す。中の `README.md` が導入説明書で、接続スクリプト、接続先の設定、devcontainer のひな形が入っている

`iamUser` に書いた IAM ユーザーには、ポリシー `RemoteClaudeUser`（タグ `remote-claude:managed=true` の付いた EC2 の起動、停止、SSM での接続）が付く。チーム内で使う前提なので、他のメンバーの EC2 にも入れる。

メンバーは `aws login`（ブラウザでのサインイン）で認証する。アクセスキーは発行しなくてよい。IAM ユーザーにはコンソールのパスワードと、AWS 管理ポリシー `SignInLocalDevelopmentAccess`（`aws login` に要る）を付けておく。

メンバーを外すときは `instances` から消して `npx cdk destroy RemoteClaude-<名前>` を実行する（`cdk deploy --all` ではスタックは消えない）。EBS も一緒に消える。

## 手元からの操作（`scripts\remote.cmd`）

AWS CLI v2（2.32.0 以降）と Session Manager Plugin が入っていて、`aws login` で認証済みであることが前提（サインインは最長 12 時間で切れるので、切れたらもう一度 `aws login` を実行する）。

```powershell
scripts\remote.cmd start        # 起動し、SSM で接続できるようになるまで待つ
scripts\remote.cmd stop         # 停止する
scripts\remote.cmd status       # 状態を表示する（EC2 と SSM Agent）
scripts\remote.cmd shell        # 止まっていたら起動して、SSM で ec2-user のシェルを開く
scripts\remote.cmd tmux [名前]  # shell と同じだが、tmux のセッションに入る（既定 main。なければ作る。切断しても作業が続く）
scripts\remote.cmd ssh          # 止まっていたら起動して、ssh remote-claude-<名前> で接続する
scripts\remote.cmd ssh-config   # ~/.ssh/config に追記する設定を表示する
```

開発は devcontainer の中で行う（EC2 のホストには Claude Code、Java、Gradle を入れない）。VS Code の拡張機能（Remote-SSH、Dev Containers）がなくても、`tmux` で入って devcontainer CLI でコンテナに入れば作業できる（[devcontainer-template/](devcontainer-template/README.md#vs-code-の拡張機能なしで使うdevcontainer-cli)）。ウィンドウを閉じても処理は続く。次に `scripts\remote.cmd tmux` を実行すると同じ画面に戻る（tmux の中から抜けるときは `Ctrl-b d`）。

接続がなく、Claude Code も作業していない状態が30分続くと、EC2 は自分で停止する。tmux で Claude Code に作業させたまま接続を切っても、作業が終わるまでは止まらない（[cdk/README](cdk/README.md#使っていないときの自動停止)）。

接続先は、環境変数 `REMOTE_CLAUDE_NAME`（既定はログインユーザー名の小文字）のスタック `RemoteClaude-<名前>` の出力から取る。リージョン、スタック名、インスタンス ID は環境変数 `REMOTE_CLAUDE_REGION`、`REMOTE_CLAUDE_STACK`、`REMOTE_CLAUDE_INSTANCE_ID` で上書きできる。スクリプトと同じフォルダに `remote-claude.config.ps1`（接続キットに入っている）があれば、その設定を使う。

ssh の Host 名は `remote-claude-<名前>`。

### 接続時に自動で起動する

`scripts\remote.cmd ssh-config` の出力を `~/.ssh/config` に追記する。ProxyCommand がこのスクリプトを呼ぶので、`ssh remote-claude-<名前>` を実行したときや VS Code の Remote-SSH で接続したときに、インスタンスが止まっていれば自動で起動してから接続する。

起動には1〜2分かかる。VS Code の Remote-SSH は既定で15秒でタイムアウトするので、VS Code の設定で延ばしておく。

```json
"remote.SSH.connectTimeout": 300
```

### 必要な IAM 権限（手元の利用者）

ポリシー `RemoteClaudeUser` の権限（`ec2:DescribeInstances`、`ec2:StartInstances`、`ec2:StopInstances`、`ssm:DescribeInstanceInformation`、`ssm:StartSession`（`AWS-StartSSHSession` と `AWS-StartInteractiveCommand` ドキュメント、対象インスタンス））。接続キットを使わずスタックの出力からインスタンス ID を取るときは、`cloudformation:DescribeStacks` も要る
