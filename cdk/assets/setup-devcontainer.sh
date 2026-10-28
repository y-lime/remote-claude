#!/bin/bash
# devcontainer に渡す設定を /etc/remote-claude に置く。何度実行してもよい
set -euxo pipefail

# Bedrock と CodeArtifact の設定。devcontainer.json の runArgs（--env-file）で渡す
install -d -m 755 /etc/remote-claude
cat > /etc/remote-claude/claude.env <<'EOF'
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=__AWS_REGION__
ANTHROPIC_MODEL=__CLAUDE_MODEL__
ANTHROPIC_DEFAULT_OPUS_MODEL=__CLAUDE_OPUS_MODEL__
ANTHROPIC_DEFAULT_SONNET_MODEL=__CLAUDE_SONNET_MODEL__
ANTHROPIC_DEFAULT_HAIKU_MODEL=__CLAUDE_HAIKU_MODEL__
CODEARTIFACT_DOMAIN=__CODEARTIFACT_DOMAIN__
CODEARTIFACT_DOMAIN_OWNER=__CODEARTIFACT_DOMAIN_OWNER__
CODEARTIFACT_URL=__CODEARTIFACT_URL__
EOF
chmod 644 /etc/remote-claude/claude.env

# Gradle が CodeArtifact を使う init スクリプト。devcontainer.json の mounts で ~/.gradle/init.d にマウントする
install -d -m 755 /etc/remote-claude/gradle
cat > /etc/remote-claude/gradle/codeartifact.init.gradle.kts <<'EOF'
__GRADLE_INIT_SCRIPT__
EOF
chmod 644 /etc/remote-claude/gradle/codeartifact.init.gradle.kts
