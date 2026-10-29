# remote-claude

Claude Code を常駐させるリモート環境（メンバーごとに AWS EC2 1台）を作る CDK（TypeScript）。

| スタック | 中身 |
|---|---|
| `RemoteClaudeBaseStack` | 全員で共有するもの：VPC、NAT、VPC エンドポイント、SG、インスタンスロール、IMDSv2 の起動テンプレート、メンバー用ポリシー `RemoteClaudeUser` |
| `RemoteClaude-<名前>` | メンバー1人ぶんの EC2。context の `instances` の項目ごとに1つ |
| `RemoteClaudeArtifactsStack` | CodeArtifact |
`cdk/` ディレクトリで作業する。設計と経緯は Obsidian の `notebook/general/remote-claude/` にある。

## 構成

構成図：[docs/architecture.drawio](docs/architecture.drawio)（`egress=nat` の場合。draw.io か VS Code の Draw.io Integration 拡張で開く）

- EC2（Amazon Linux 2023、t3.large、EBS gp3 100GB 暗号化）。開発は devcontainer（[devcontainer-template/](../devcontainer-template/README.md)）の中で行う前提で、ホストには Docker、docker compose、devcontainer CLI と、git、git-lfs、tmux、jq、rsync、zip / unzip、tree、htop、lsof、vim、emacs（nox）などのコマンドだけを初回起動時に入れる（`assets/user-data.sh`）。Claude Code、Java、Gradle はホストには入れない
- コンテナのログは 10MB × 3 ファイルでローテーションする（`/etc/docker/daemon.json`）
- devcontainer のベースイメージ（`mcr.microsoft.com/devcontainers/base:noble`）を初回起動時に pull しておく。`devcontainer-template` の `image` を変えたら `assets/user-data.sh` もそろえる（テストで確認する）
- devcontainer に渡す設定（Bedrock と CodeArtifact の環境変数 `/etc/remote-claude/claude.env`、Gradle の init スクリプト `/etc/remote-claude/gradle/`）を置く（`assets/setup-devcontainer.sh`）
- SSM のシェルは `scripts\remote.cmd shell`（docker グループに入っている ec2-user で開く）を使う
- 使っていなければ自分で停止する（`assets/setup-idle-stop.sh`）。下記
- 接続は SSM Session Manager だけ（SSH over SSM）。セキュリティグループのインバウンドは全閉
- CodeArtifact は別スタック `RemoteClaudeArtifactsStack` に作る。EC2 のスタックを消しても残る
- Claude の認証は Bedrock（インスタンスロール）。IMDSv2 必須、ホップ数 2（devcontainer からロールを使うため）
- 外向き通信は context の `egress` で切り替える

| egress | 配置 | 外向き | VPC エンドポイント |
|---|---|---|---|
| `nat`（既定） | プライベート | NAT 経由 | ssm / ssmmessages / ec2messages / bedrock-runtime / S3 |
| `public` | パブリック（パブリック IP） | IGW 経由 | S3 のみ |
| `isolated` | プライベート（閉域） | なし | `nat` と同じ |

`isolated` では GitHub、npm、mcr.microsoft.com、ghcr.io、CodeArtifact に届かない。docker compose、devcontainer CLI、devcontainer のイメージを事前に入れ、CodeArtifact 用のエンドポイント（codeartifact.api、codeartifact.repositories）を足す必要がある。

### CodeArtifact（Gradle の依存ライブラリ）

ドメイン `remote-claude` に、リポジトリを3つ作る。外部接続は1つのリポジトリに1つしか付けられないので、公開リポジトリは別にして上流につなぐ。

| リポジトリ | 役割 |
|---|---|
| `libs` | Gradle が見るのはここだけ。自分たちのライブラリもここに publish する。上流は下の2つ（この順に探す） |
| `maven-central-store` | Maven Central（`public:maven-central`）のキャッシュ |
| `gradle-plugins-store` | Gradle Plugin Portal（`public:maven-gradleplugins`）のキャッシュ |

- ドメインとリポジトリは `RETAIN`。`cdk destroy` しても消えないので、不要になったらコンソールか CLI で消す
- EC2 のロールは読み取りだけ。`/etc/remote-claude/claude.env` に `CODEARTIFACT_DOMAIN`、`CODEARTIFACT_DOMAIN_OWNER`、`CODEARTIFACT_URL` を書く
- Gradle は init スクリプト（`assets/codeartifact.init.gradle.kts` → `/etc/remote-claude/gradle/`、devcontainer の `~/.gradle/init.d/` にマウント）で、プラグインと依存ライブラリの両方を CodeArtifact から取る。認証トークンはビルドのたびに `aws codeartifact get-authorization-token` で取るので、期限切れを気にしなくてよい
- `RepositoriesMode.PREFER_SETTINGS` にするので、`build.gradle(.kts)` に書いた `repositories { mavenCentral() }` などは使われない（警告が出る）
- 会社の既存ドメインを使うときは、`-c codeArtifactCreate=false -c codeArtifactDomain=<名前> -c codeArtifactDomainOwner=<アカウント>` にする（別アカウントなら、ドメインとリポジトリのポリシーでこのロールの読み取りを許可してもらう）

自分たちのライブラリを手元から publish する例（publish の権限は、手元の利用者の IAM で付ける）：

```powershell
$env:CODEARTIFACT_AUTH_TOKEN = aws codeartifact get-authorization-token --domain remote-claude --query authorizationToken --output text
```

```kotlin
// build.gradle.kts（maven-publish プラグイン）
publishing {
    repositories {
        maven {
            url = uri("https://remote-claude-<アカウント>.d.codeartifact.ap-northeast-1.amazonaws.com/maven/libs/")
            credentials { username = "aws"; password = System.getenv("CODEARTIFACT_AUTH_TOKEN") }
        }
    }
}
```

### 使っていないときの自動停止

次の3つがどれもない状態が `idleStopMinutes`（既定 30分）続くと、EC2 は自分でシャットダウンして停止する。systemd timer（`remote-claude-idle-stop.timer`）が5分ごとに確かめる。

- SSH の接続（VS Code の Remote-SSH を含む）
- SSM のセッション（`scripts\remote.cmd shell` / `tmux`）
- 作業中の Claude Code。devcontainer の中の Claude Code が hook（managed settings、`/etc/claude-code`）で、作業の始まり（プロンプトの送信、ツールの実行）と終わり（応答の完了、許可や入力の待ち）を `/run/remote-claude/claude-activity` に書く。tmux で動かしたまま接続を切っても、作業が終わるまでは止まらない

- 許可の確認や入力を待っている Claude Code は、作業していないとみなす（人がいないので、待っていても進まない）
- 中断などで終わりが記録されなかったセッションは、最後の記録から60分たつと作業していないとみなす
- 停止すると tmux のセッションと Claude Code のプロセスは終わる。会話は `claude --continue`（または `--resume`）で続きから再開できる
- 起動直後と初回セットアップ中は止めない。止めたくないときは `-c idleStopMinutes=0`
- 判定の様子は `journalctl -u remote-claude-idle-stop` で見られる

### 月額の目安（東京、24時間稼働）

| 項目 | 金額 |
|---|---|
| t3.large | 約 $80（夜間だけ動かすなど、止めている間はかからない） |
| NAT Gateway | 約 $45 + 通信量 |
| インターフェースエンドポイント 4本 | 約 $41 |
| EBS 100GB | 約 $10 |
| CodeArtifact | 保存 $0.05/GB・月 + リクエスト 1万件あたり $0.05（ほぼかからない） |

Bedrock の利用料は含まない。EC2 と EBS は1人あたりの金額。NAT とエンドポイントは全員で1つなので、人数が増えても変わらない。EC2 を止めていても、NAT とエンドポイントの約 $86 と、1人あたり EBS の約 $10 はかかる。

## 設定（`cdk.json` の context、`-c key=value` でも上書きできる）

| キー | 既定値 |
|---|---|
| `region` | `ap-northeast-1` |
| `egress` | `nat` |
| `instances` | メンバーごとの EC2（下記） |
| `instanceType` | `t3.large`（全員の既定値） |
| `volumeSizeGiB` | `100`（全員の既定値） |
| `claudeModel` | `opus`（Claude Code が既定で使うモデル。別名か推論プロファイルの ID） |
| `claudeOpusModel` | `global.anthropic.claude-opus-4-6-v1`（jp. がないので global.） |
| `claudeSonnetModel` | `jp.anthropic.claude-sonnet-4-6` |
| `claudeHaikuModel` | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `idleStopMinutes` | `30`（使っていない状態がこの分数続いたら停止する。0 なら止めない） |
| `codeArtifactCreate` | `true`（false なら CodeArtifact のスタックを作らず、既存のドメインを使う） |
| `codeArtifactDomain` | `remote-claude` |
| `codeArtifactDomainOwner` | なし（スタックのアカウント） |
| `codeArtifactRepository` | `libs`（Gradle が見るリポジトリ） |

`instances` は名前（英小文字、数字、`-`）から個別設定へのマップ。個別設定はどれも省略できる。

| キー | 意味 |
|---|---|
| `iamUser` | 接続を許可する既存の IAM ユーザー。ポリシー `RemoteClaudeUser` を付ける |
| `sshPublicKey` | ec2-user の authorized_keys に登録する公開鍵（文字列） |
| `sshPublicKeyPath` | 同じく、ファイルで渡す（自分の鍵向け。例 `~/.ssh/id_ed25519.pub`） |
| `instanceType` / `volumeSizeGiB` | 全員の既定値を上書きする |

Java と Gradle のバージョンは `devcontainer-template/.devcontainer/devcontainer.json` の java の feature で決める（ホストには入れない）。

Claude 5 系は、今のアカウントでは Bedrock の利用規約に同意できない（`agreementAvailability: NOT_AVAILABLE`）ため使えない。Opus 4.7 と 4.8 も同じ（2026-10-20 時点）。使えるか確かめるには `aws bedrock get-foundation-model-availability --model-id anthropic.<モデル>` を実行する。

公開鍵は初回起動時に1回だけ登録する。鍵を差し替えるときは SSM でログインして `authorized_keys` を直接編集する。

## 手元（Windows）の準備

1. AWS CLI v2 と Session Manager Plugin を入れる（`session-manager-plugin` が実行できればよい）
2. `aws sso login` などで認証する
3. Bedrock コンソールで Anthropic のモデルを有効化しておく（初回のみ）

## デプロイ

```powershell
cd cdk
npm ci
npx cdk bootstrap   # アカウントとリージョンごとに初回だけ
npx cdk diff --all
npm run deploy      # cdk deploy --all のあと、接続キットを ../kits/ に作る（scripts/make-kits.ts）
```

初回起動時のセットアップには数分かかる。終わったかどうかは `sudo cat /var/log/cloud-init-output.log` で確認する。

接続キット（`kits/remote-claude-<名前>.zip`）は、デプロイ済みの `RemoteClaude-*` スタックの出力から毎回全員分を作り直す。中身は `scripts/remote.cmd`・`remote.ps1`、接続先を書いた `remote-claude.config.ps1`、導入説明書（`assets/kit-README.md` から作る）、`devcontainer-template/.devcontainer/`。

### 1台だけだった頃（`RemoteClaudeStack`）からの移行

`RemoteClaudeStack` の EC2 はそのまま引き継げず、新しく作ることになる（EBS の中身は移らない）。作業を退避し、`npm run deploy` で新しいスタックを作って確かめてから、`npx cdk destroy RemoteClaudeStack` で古いスタックを消す。

## 接続

起動、停止、接続はリポジトリ直下の `scripts\remote.cmd` で行う（[README](../README.md) を参照）。メンバーは接続キットの `remote.cmd` を使う。

VS Code では Remote-SSH で `remote-claude-<名前>` に接続する。

## 注意

- `cdk destroy` を実行すると、EBS（`/work` の中身も含む）が一緒に削除される
- user data（`assets/` のファイル、公開鍵、モデル指定、CodeArtifact の指定）を変えると、インスタンスは作り直しになる。全員共通の設定を変えると全員分が作り直しになる。EBS が消え、インスタンス ID も変わる（`npm run deploy` で作り直したキットを渡し直し、`ssh-config` も出し直してもらう）。必ず `cdk diff` で確認してからデプロイする
- 今あるインスタンスに設定だけ反映したいときは、`assets/setup-devcontainer.sh` のプレースホルダーを置き換えて、SSM Run Command で流す（何度実行してもよい）。devcontainer は作り直す（Rebuild Container）と新しい設定を読む
- 開発コマンド：`npm test`（テンプレートのテスト）、`npx cdk synth`
