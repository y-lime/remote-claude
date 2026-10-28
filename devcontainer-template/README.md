# devcontainer のひな形

remote-claude の EC2 上で動かす devcontainer。アプリのリポジトリに `.devcontainer/` ごとコピーして使う。

- 入るもの：Ubuntu 24.04（`mcr.microsoft.com/devcontainers/base:noble`）、Node.js 24、Java（Amazon Corretto 25）、Gradle 9.8.2、AWS CLI、GitHub CLI、Claude Code（ネイティブ版）、VS Code の Claude Code 拡張
- Bedrock と CodeArtifact の設定は、EC2 の `/etc/remote-claude/claude.env` を `--env-file` で渡す。AWS の認証情報は IMDS からインスタンスロールのものを取るので、コンテナにキーは置かない
- Gradle は、EC2 の `/etc/remote-claude/gradle`（CodeArtifact を使う init スクリプト）を `~/.gradle/init.d` にマウントして使う。依存ライブラリのキャッシュは名前付きボリューム `remote-claude-gradle` に置く
- Claude Code の設定と履歴は、名前付きボリューム `remote-claude-config` に置く。コンテナを作り直しても残り、プロジェクト間で共有する

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

## VS Code の拡張機能なしで使う（devcontainer CLI）

Remote-SSH や Dev Containers が使えないときは、EC2 のターミナル（`scripts\remote.cmd tmux`）で devcontainer CLI（EC2 に入れてある）を使う。同じ devcontainer.json から同じコンテナができるので、あとで VS Code から開くこともできる。

```bash
devcontainer up --workspace-folder /work/<リポジトリ>
devcontainer exec --workspace-folder /work/<リポジトリ> bash -l
```

止めるときは `docker stop $(docker ps -q --filter label=devcontainer.local_folder=/work/<リポジトリ>)`。

## 確認用のコマンド（コンテナの中）

```bash
aws sts get-caller-identity          # インスタンスロールになっていれば OK
env | grep -E '^(ANTHROPIC|CLAUDE_CODE|AWS_REGION|CODEARTIFACT)'
claude -p "Reply with just OK" </dev/null
java -version && gradle --version
```
