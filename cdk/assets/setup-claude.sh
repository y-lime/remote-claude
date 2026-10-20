#!/bin/bash
# Claude Code（ネイティブ版）を ec2-user に入れて、Bedrock を使う設定をする。何度実行してもよい
set -euxo pipefail

# Bedrock の設定。ホストのシェル（profile.d）と devcontainer（runArgs の --env-file）の両方から読む
install -d -m 755 /etc/remote-claude
cat > /etc/remote-claude/claude.env <<'EOF'
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=__AWS_REGION__
ANTHROPIC_MODEL=__CLAUDE_MODEL__
ANTHROPIC_DEFAULT_OPUS_MODEL=__CLAUDE_OPUS_MODEL__
ANTHROPIC_DEFAULT_SONNET_MODEL=__CLAUDE_SONNET_MODEL__
ANTHROPIC_DEFAULT_HAIKU_MODEL=__CLAUDE_HAIKU_MODEL__
EOF
chmod 644 /etc/remote-claude/claude.env

cat > /etc/profile.d/claude-code.sh <<'EOF'
set -a
. /etc/remote-claude/claude.env
set +a
EOF
# 旧版の user data が作っていたファイル
rm -f /etc/profile.d/claude-bedrock.sh

CLAUDE_BIN=/home/ec2-user/.local/bin/claude
if [ ! -x "$CLAUDE_BIN" ]; then
  sudo -iu ec2-user bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
fi
sudo -iu ec2-user "$CLAUDE_BIN" --version
