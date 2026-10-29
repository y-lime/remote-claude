#!/bin/bash
# 使っていないときに自分で停止する仕掛けを入れる。何度実行してもよい。
# 「使っていない」は、SSH と SSM の接続がなく、Claude Code も作業していない状態。これが IDLE_STOP_MINUTES 分続いたら止める
set -euxo pipefail

IDLE_STOP_MINUTES=__IDLE_STOP_MINUTES__

# Claude Code の hook が、作業中のセッションごとにファイルを置くディレクトリ。/run なので起動のたびに空になる
cat > /etc/tmpfiles.d/remote-claude.conf <<'EOF'
d /run/remote-claude 0755 root root -
d /run/remote-claude/claude-activity 1777 root root -
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/remote-claude.conf

# devcontainer の /etc/claude-code にマウントする managed settings と hook
install -d -m 755 /etc/remote-claude/claude-code
cat > /etc/remote-claude/claude-code/activity-hook.sh <<'EOF'
#!/bin/sh
# Claude Code の hook。作業中はセッションのファイルを更新し、応答を終えたら（Stop など）消す。ホストの remote-claude-idle-stop が見る
dir=/run/remote-claude/claude-activity
input=$(cat)
field() { printf '%s' "$input" | sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" | head -n 1; }
session=$(field session_id)
[ -n "$session" ] && [ -d "$dir" ] || exit 0
case "$(field hook_event_name)" in
  # Notification は許可の確認や入力待ち。人の操作を待っているだけなので、作業していないとみなす
  Stop|SessionEnd|Notification) rm -f "$dir/$session" ;;
  *) touch "$dir/$session" ;;
esac
exit 0
EOF
chmod 755 /etc/remote-claude/claude-code/activity-hook.sh

cat > /etc/remote-claude/claude-code/managed-settings.json <<'EOF'
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/etc/claude-code/activity-hook.sh" }] }],
    "PreToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/etc/claude-code/activity-hook.sh" }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "/etc/claude-code/activity-hook.sh" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "/etc/claude-code/activity-hook.sh" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "/etc/claude-code/activity-hook.sh" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "/etc/claude-code/activity-hook.sh" }] }]
  }
}
EOF
chmod 644 /etc/remote-claude/claude-code/managed-settings.json

# 5分ごとに使っているかを確かめ、使われていない時間が続いたら止める（インスタンスの中からのシャットダウンは「停止」になる）
cat > /usr/local/sbin/remote-claude-idle-stop <<EOF
#!/bin/bash
set -euo pipefail
IDLE_STOP_MINUTES=$IDLE_STOP_MINUTES
EOF
cat >> /usr/local/sbin/remote-claude-idle-stop <<'EOF'
# hook の更新がこれより古いセッションは、中断などで Stop が来なかったものとみなす
ACTIVE_TIMEOUT_MINUTES=60
state=/run/remote-claude/last-active

reason=
if cloud-init status 2>/dev/null | grep -q running; then
  reason='初回セットアップ中'
elif pgrep -f ssm-session-worker >/dev/null; then
  reason='SSM のセッションがある'
elif [ -n "$(ss -Htn state established '( sport = :22 )')" ]; then
  reason='SSH の接続がある'
elif [ -n "$(find /run/remote-claude/claude-activity -type f -mmin -$ACTIVE_TIMEOUT_MINUTES 2>/dev/null)" ]; then
  reason='Claude Code が作業中'
fi

now=$(date +%s)
# 起動直後は state がないので、ここから数え始める
if [ -n "$reason" ] || [ ! -f "$state" ]; then
  echo "$now" > "$state"
  echo "使用中: ${reason:-起動直後}"
  exit 0
fi

idle=$(( (now - $(cat "$state")) / 60 ))
echo "使われていない: ${idle} 分（${IDLE_STOP_MINUTES} 分で停止）"
if [ "$idle" -ge "$IDLE_STOP_MINUTES" ]; then
  echo '停止する'
  systemctl poweroff
fi
EOF
chmod 755 /usr/local/sbin/remote-claude-idle-stop

cat > /etc/systemd/system/remote-claude-idle-stop.service <<'EOF'
[Unit]
Description=remote-claude: 使っていなければ停止する

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/remote-claude-idle-stop
EOF
cat > /etc/systemd/system/remote-claude-idle-stop.timer <<'EOF'
[Unit]
Description=remote-claude: 使っているかを5分ごとに確かめる

[Timer]
OnBootSec=5min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
# 0 なら止めない
if [ "$IDLE_STOP_MINUTES" -gt 0 ]; then
  systemctl enable --now remote-claude-idle-stop.timer
else
  systemctl disable --now remote-claude-idle-stop.timer || true
fi
