#!/bin/bash
# Amazon Linux 2023 の初回起動時に1回だけ実行される。
# 開発は devcontainer の中で行うので、ホストには Docker と、devcontainer に渡す設定（assets/setup-devcontainer.sh）だけを置く
set -euxo pipefail

timedatectl set-timezone Asia/Tokyo

# nodejs24 は devcontainer CLI 用。ほかはホストでリポジトリやコンテナを扱うときのコマンド
# curl は入れない（AL2023 は curl-minimal が入っていて、curl を指定すると衝突して失敗する）
dnf install -y docker git tmux jq nodejs24 nodejs24-npm \
  git-lfs rsync unzip zip tree htop lsof vim-enhanced emacs-nox

# devcontainer は shutdownAction: none で動かし続けるので、コンテナのログが EBS を食いつぶさないようにする
install -d /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
systemctl enable --now docker
usermod -aG docker ec2-user

# 外に出られない構成（egress=isolated）では次の2つは失敗するので無視する
# docker compose プラグイン（AL2023 の docker パッケージには含まれない）
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose \
  && chmod +x /usr/local/lib/docker/cli-plugins/docker-compose \
  || echo "docker compose のインストールをスキップ"
# devcontainer CLI。VS Code なしで tmux から devcontainer を起動、接続するのに使う
npm install -g @devcontainers/cli \
  || echo "devcontainer CLI のインストールをスキップ"

# SSH over SSM（AWS-StartSSHSession）用の公開鍵
SSH_PUBLIC_KEY='__SSH_PUBLIC_KEY__'
if [ -n "$SSH_PUBLIC_KEY" ]; then
  install -d -m 700 -o ec2-user -g ec2-user /home/ec2-user/.ssh
  echo "$SSH_PUBLIC_KEY" >> /home/ec2-user/.ssh/authorized_keys
  chown ec2-user:ec2-user /home/ec2-user/.ssh/authorized_keys
  chmod 600 /home/ec2-user/.ssh/authorized_keys
fi

# SSM 越しだと、tmux が接続時に端末へ問い合わせた返事（画面サイズや色）が既定の 10ms に間に合わず、
# 「10;rgb:...」のような文字列が入力として入ってしまう。待ち時間を延ばす
cat > /etc/tmux.conf <<'EOF'
set -sg escape-time 200
EOF

# 作業ディレクトリ（リポジトリの clone 先）
install -d -o ec2-user -g ec2-user /work

# devcontainer のベースイメージを先に取っておき、初回の作成を速くする（devcontainer-template の image とそろえる）
docker pull mcr.microsoft.com/devcontainers/base:noble \
  || echo "devcontainer のベースイメージの取得をスキップ"

# この後に assets/setup-devcontainer.sh（devcontainer に渡す設定）が続く
