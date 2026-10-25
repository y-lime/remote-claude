#!/bin/bash
# Java（Amazon Corretto）と Gradle を入れ、Gradle が CodeArtifact を見るようにする。何度実行してもよい
set -euxo pipefail

dnf install -y java-__JAVA_VERSION__-amazon-corretto-devel unzip

# Gradle は dnf にないので配布物を入れる。プロジェクトに gradlew があればそちらが優先される
GRADLE_VERSION=__GRADLE_VERSION__
GRADLE_HOME=/opt/gradle/gradle-$GRADLE_VERSION
if [ ! -x "$GRADLE_HOME/bin/gradle" ]; then
  tmp=$(mktemp -d)
  base="https://services.gradle.org/distributions/gradle-$GRADLE_VERSION-bin.zip"
  curl -fsSL "$base" -o "$tmp/gradle.zip"
  echo "$(curl -fsSL "$base.sha256")  $tmp/gradle.zip" | sha256sum -c -
  install -d /opt/gradle
  unzip -q "$tmp/gradle.zip" -d /opt/gradle
  rm -rf "$tmp"
fi
ln -sfn "$GRADLE_HOME/bin/gradle" /usr/local/bin/gradle

# CodeArtifact を使う init スクリプト。devcontainer にもこのディレクトリをマウントして使う
install -d -m 755 /etc/remote-claude/gradle
cat > /etc/remote-claude/gradle/codeartifact.init.gradle.kts <<'EOF'
__GRADLE_INIT_SCRIPT__
EOF
chmod 644 /etc/remote-claude/gradle/codeartifact.init.gradle.kts

install -d -o ec2-user -g ec2-user /home/ec2-user/.gradle /home/ec2-user/.gradle/init.d
ln -sfn /etc/remote-claude/gradle/codeartifact.init.gradle.kts /home/ec2-user/.gradle/init.d/codeartifact.init.gradle.kts

java -version
gradle --version
