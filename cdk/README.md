# remote-claude

Claude Code を常駐させるリモート環境（AWS EC2 1台）を作る CDK（TypeScript）。
`cdk/` ディレクトリで作業する。設計と経緯は Obsidian の `notebook/general/remote-claude/` にある。

## 構成

構成図：[docs/architecture.drawio](docs/architecture.drawio)（`egress=nat` の場合。draw.io か VS Code の Draw.io Integration 拡張で開く）

- EC2（Amazon Linux 2023、t3.large、EBS gp3 100GB 暗号化）。Docker、git、tmux、jq、docker compose、Node.js 24（npm）を初回起動時に入れる
- Claude Code（ネイティブ版）を ec2-user に入れ、`/etc/profile.d/claude-code.sh` で Bedrock を使う設定をする（`assets/setup-claude.sh`）。ssm-user には入らないので、SSM のシェルは `scripts\remote.cmd shell`（ec2-user で開く）を使う
- 接続は SSM Session Manager だけ（SSH over SSM）。セキュリティグループのインバウンドは全閉
- Claude の認証は Bedrock（インスタンスロール）。IMDSv2 必須、ホップ数 2（devcontainer からロールを使うため）
- 外向き通信は context の `egress` で切り替える

| egress | 配置 | 外向き | VPC エンドポイント |
|---|---|---|---|
| `nat`（既定） | プライベート | NAT 経由 | ssm / ssmmessages / ec2messages / bedrock-runtime / S3 |
| `public` | パブリック（パブリック IP） | IGW 経由 | S3 のみ |
| `isolated` | プライベート（閉域） | なし | `nat` と同じ |

`isolated` では GitHub、npm、Docker Hub に届かない。Claude Code と devcontainer のイメージを事前に入れておく必要がある。

### 月額の目安（東京、24時間稼働）

| 項目 | 金額 |
|---|---|
| t3.large | 約 $80（夜間だけ動かすなど、止めている間はかからない） |
| NAT Gateway | 約 $45 + 通信量 |
| インターフェースエンドポイント 4本 | 約 $41 |
| EBS 100GB | 約 $10 |

Bedrock の利用料は含まない。

## 設定（`cdk.json` の context、`-c key=value` でも上書きできる）

| キー | 既定値 |
|---|---|
| `region` | `ap-northeast-1` |
| `egress` | `nat` |
| `instanceType` | `t3.large` |
| `volumeSizeGiB` | `100` |
| `sshPublicKeyPath` | `~/.ssh/id_ed25519.pub`（ec2-user の authorized_keys に登録する） |
| `claudeModel` | `opus`（Claude Code が既定で使うモデル。別名か推論プロファイルの ID） |
| `claudeOpusModel` | `global.anthropic.claude-opus-4-6-v1`（jp. がないので global.） |
| `claudeSonnetModel` | `jp.anthropic.claude-sonnet-4-6` |
| `claudeHaikuModel` | `jp.anthropic.claude-haiku-4-5-20251001-v1:0` |

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
npx cdk diff
npx cdk deploy
```

出力の `InstanceId` を控える。初回起動時のセットアップには数分かかる。終わったかどうかは `sudo cat /var/log/cloud-init-output.log` で確認する。

## 接続

起動、停止、接続はリポジトリ直下の `scripts\remote.cmd` で行う（[README](../README.md) を参照）。

VS Code では Remote-SSH で `remote-claude` に接続する。

## 注意

- `cdk destroy` を実行すると、EBS（`/work` の中身も含む）が一緒に削除される
- user data（`assets/*.sh`、公開鍵、モデル指定）を変えると、インスタンスは作り直しになる。EBS が消え、インスタンス ID も変わる（`scripts\remote.cmd ssh-config` で設定を出し直す）。必ず `cdk diff` で確認してからデプロイする
- 今あるインスタンスに設定だけ反映したいときは、`assets/setup-claude.sh` を SSM Run Command で流す（何度実行してもよい）
- 開発コマンド：`npm test`（テンプレートのテスト）、`npx cdk synth`
