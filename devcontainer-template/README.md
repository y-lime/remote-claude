# devcontainer のひな形

remote-claude の EC2 上で動かす devcontainer。アプリのリポジトリに `.devcontainer/` ごとコピーして使う。

- 入るもの：Ubuntu 24.04（`mcr.microsoft.com/devcontainers/base:noble`）、Node.js 24、AWS CLI、GitHub CLI、Claude Code（ネイティブ版）、VS Code の Claude Code 拡張
- Bedrock の設定は、EC2 の `/etc/remote-claude/claude.env` を `--env-file` で渡す。AWS の認証情報は IMDS からインスタンスロールのものを取るので、コンテナにキーは置かない
- Claude Code の設定と履歴は、名前付きボリューム `remote-claude-config` に置く。コンテナを作り直しても残り、プロジェクト間で共有する
- Java（Corretto）が必要なら、`devcontainer.json` の java の行のコメントを外す

EC2 の外（手元の Docker Desktop など）では `/etc/remote-claude/claude.env` がないので起動できない。

## 手元の準備（1回だけ）

1. VS Code に拡張機能 **Remote - SSH** と **Dev Containers** を入れる
2. `scripts\remote.cmd ssh-config` の出力を `~/.ssh/config` に追記する（インスタンスを作り直したら出し直す）
3. VS Code の設定（settings.json）に次を追加する。止まっているインスタンスの起動を待てるようにするため

   ```json
   "remote.SSH.connectTimeout": 300,
   "remote.SSH.remotePlatform": { "remote-claude": "linux" }
   ```

## 使い方

1. VS Code で **Remote-SSH: Connect to Host...** → `remote-claude` を選ぶ。止まっていれば自動で起動する
2. リモートのターミナルで、リポジトリを `/work` に clone する
3. ひな形をリポジトリにコピーする（手元の PowerShell で実行）

   ```powershell
   scp -r devcontainer-template\.devcontainer remote-claude:/work/<リポジトリ>/
   ```

4. VS Code で `/work/<リポジトリ>` を開き、**Dev Containers: Reopen in Container** を実行する。初回はイメージの取得とビルドに数分かかる
5. コンテナのターミナルで `claude` を実行する

clone を省きたいときは、Remote-SSH で接続したウィンドウから **Dev Containers: Clone Repository in Container Volume...** を使う方法もある。この場合、ソースは `/work` ではなく Docker のボリュームに置かれる。

## 確認用のコマンド（コンテナの中）

```bash
aws sts get-caller-identity          # インスタンスロールになっていれば OK
env | grep -E '^(ANTHROPIC|CLAUDE_CODE|AWS_REGION)'
claude -p "Reply with just OK" </dev/null
```
