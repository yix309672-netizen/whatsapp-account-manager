#!/usr/bin/env bash
# 可靠性组件安装：备用隧道 + 看门狗 timer
# 前置：/etc/cloudflared/token-b 已写入（第二条隧道的 token）
set -euo pipefail

# ---------- 1. 备用隧道 cloudflared-b ----------
cat > /etc/systemd/system/cloudflared-b.service <<'UNIT'
[Unit]
Description=Cloudflare Tunnel client (standby)
After=network-online.target
Wants=network-online.target

[Service]
# 注意：不能用 Type=notify + sh -c 包装（SIGTERM/SD_NOTIFY 传递会失败，启动超时）
Type=simple
ExecStart=/bin/sh -c '/usr/local/bin/cloudflared --no-autoupdate tunnel run --token "$(cat /etc/cloudflared/token-b)"'
Restart=always
RestartSec=5s
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now cloudflared-b

# ---------- 2. 看门狗 ----------
install -m 0755 "$(dirname "$0")/watchdog.sh" /usr/local/bin/waam-watchdog.sh

cat > /etc/systemd/system/waam-watchdog.service <<'UNIT'
[Unit]
Description=WAAM watchdog (health check + auto heal)
After=network-online.target

[Service]
Type=oneshot
EnvironmentFile=-/etc/waam.env
ExecStart=/usr/local/bin/waam-watchdog.sh
UNIT

cat > /etc/systemd/system/waam-watchdog.timer <<'UNIT'
[Unit]
Description=Run WAAM watchdog every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now waam-watchdog.timer

echo "--- 状态 ---"
systemctl is-active waam cloudflared cloudflared-b waam-watchdog.timer
systemctl list-timers waam-watchdog.timer --no-pager | head -3
