# remote-claude 接続キット（__NAME__ さん用）

AWS 上の EC2（`__INSTANCE_ID__`、__REGION__）で Claude Code を動かすための接続キットです。手元の Windows から、このフォルダのスクリプトで EC2 を起動し、接続します。
EC2 は使っていないと自動で止まり、接続するときに自動で起動します。

| ファイル | 中身 |
|---|---|
| `remote.cmd` / `remote.ps1` | EC2 を起動、停止し、接続するスクリプト |
| `remote-claude.config.ps1` | 接続先の設定（書き換えない） |
| `.devcontainer/` | EC2 上で使う開発コンテナのひな形（Java、Gradle、Claude Code 入り） |

## 1. 準備（1回だけ）

1. このフォルダを好きな場所に置く（例：`C:\tools\remote-claude`）。以下、このフォルダで PowerShell を開いて実行する
2. AWS CLI v2（2.32.0 以降）を入れる：<https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html>。`aws --version` で確かめられる
3. Session Manager Plugin を入れる：<https://docs.aws.amazon.com/systems-manager/latest/userguide/install-plugin-windows.html>
4. `aws login` で、自分の IAM ユーザーでサインインする。プロファイル名は `remote-claude`。ブラウザが開くので AWS コンソールと同じようにサインインする。リージョンを聞かれたら `__REGION__` と答える

   ```powershell
   aws login --profile remote-claude
   ```

   - サインインは最長 12 時間で切れる。切れたら（`.\remote.cmd` が認証のエラーで止まったら）同じコマンドをもう一度実行する
   - ブラウザが開かないときは `aws login --profile remote-claude --remote` を実行し、表示された URL を別のブラウザで開く
   - 別のプロファイル名にしたいときは、環境変数 `AWS_PROFILE` を設定しておけばそちらを使う

5. 確認する。`state` と `ssm` が表示されれば OK（止まっていれば `stopped` と表示される）

   ```powershell
   .\remote.cmd status
   ```

   `aws login` や `status` で AccessDenied になるときは、キットをくれた人に IAM ユーザー名を伝えて権限を付けてもらう

## 2. 使い方

```powershell
.\remote.cmd tmux        # 止まっていれば起動して、EC2 のターミナル（tmux）に入る。起動には1〜2分かかる
.\remote.cmd stop        # 停止する（放っておいても、使っていなければ __IDLE_STOP_MINUTES__ 分で止まる）
.\remote.cmd status      # 状態を表示する
```

- tmux から抜けるときは `Ctrl-b d`。接続を切っても EC2 上の作業は続き、次に `.\remote.cmd tmux` を実行すると同じ画面に戻る
- 接続がなく、Claude Code も作業していない状態が __IDLE_STOP_MINUTES__ 分続くと、EC2 は自分で停止する。止まると tmux の中身は消えるが、Claude Code の会話は `claude --continue` で続きから再開できる

## 3. 開発を始める（devcontainer）

EC2 のホストには Claude Code や Java は入っていません。リポジトリごとに devcontainer を立てて、その中で作業します。

```bash
# EC2 のターミナル（.\remote.cmd tmux）で
cd /work
git clone <リポジトリの URL>
cd <リポジトリ>
# .devcontainer/ がリポジトリになければ、このキットの .devcontainer/ をコピーする（下記）
devcontainer up --workspace-folder .
devcontainer exec --workspace-folder . bash -l
claude        # コンテナの中で Claude Code を起動
```

キットの `.devcontainer/` を EC2 に送るには、SSH を設定（次の節）したうえで、手元の PowerShell から：

```powershell
scp -r .devcontainer __HOST_ALIAS__:/work/<リポジトリ>/
```

Claude Code は Bedrock（EC2 のロール）で動くので、API キーやログインは要りません。

## 4. VS Code から使う（任意。SSH の公開鍵を登録してもらった場合）

SSH の公開鍵（`~/.ssh/id_ed25519.pub`）をキットをくれた人に渡して、EC2 に登録してもらっている場合だけ使えます。鍵がないときは `ssh-keygen -t ed25519` で作って渡してください（登録すると EC2 は作り直しになり、中身が消えます。最初に頼むのがおすすめ）。

1. 次の出力を `~/.ssh/config` に追記する

   ```powershell
   .\remote.cmd ssh-config
   ```

   キットのフォルダを移動したら出し直す

2. VS Code に拡張機能 **Remote - SSH** と **Dev Containers** を入れ、設定（settings.json）に追加する（止まっている EC2 の起動を待つため）

   ```json
   "remote.SSH.connectTimeout": 300,
   "remote.SSH.remotePlatform": { "__HOST_ALIAS__": "linux" }
   ```

3. **Remote-SSH: Connect to Host...** → `__HOST_ALIAS__`。止まっていれば自動で起動する
4. `/work/<リポジトリ>` を開いて **Dev Containers: Reopen in Container**

## 困ったとき

- 認証のエラー（期限切れ、認証情報がない）：`aws login --profile remote-claude` でサインインし直す
- 接続できない：`.\remote.cmd status` で `state` が `running`、`ssm` が `Online` か確かめる。起動直後は `Online` になるまで1〜2分かかる
- 初回起動直後は、EC2 のセットアップ（Docker などのインストール）に数分かかる。`sudo cloud-init status --wait` で終わるのを待てる
- その他はキットをくれた人に聞く（インスタンス ID `__INSTANCE_ID__` を伝える）
