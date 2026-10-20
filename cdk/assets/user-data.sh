#!/bin/bash
# Amazon Linux 2023 の初回起動時に1回だけ実行される
set -euxo pipefail

timedatectl set-timezone Asia/Tokyo

dnf install -y docker git tmux jq nodejs24 nodejs24-npm
systemctl enable --now docker
usermod -aG docker ec2-user

# docker compose プラグイン（AL2023 の docker パッケージには含まれない）。外に出られない構成では失敗するので無視する
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose \
  && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
  || echo "docker compose のインストールをスキップ"

# SSH over SSM（AWS-StartSSHSession）用の公開鍵
SSH_PUBLIC_KEY='__SSH_PUBLIC_KEY__'
if [ -n "$SSH_PUBLIC_KEY" ]; then
  install -d -m 700 -o ec2-user -g ec2-user /home/ec2-user/.ssh
  echo "$SSH_PUBLIC_KEY" >> /home/ec2-user/.ssh/authorized_keys
  chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys
  chmod 600 /home/ec2-user/.ssh/authorized_keys
fi

# 作業ディレクトリ（リポジトリの clone 先）
install -d -o ec2-user -g ec2-user /work

# この後に assets/setup-claude.sh（Claude Code のインストールと Bedrock の設定）が続く
