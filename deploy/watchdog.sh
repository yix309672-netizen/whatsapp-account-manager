#!/usr/bin/env bash
# WAAM 看门狗：由 systemd timer 每 5 分钟跑一次。
# 目标：服务意外死掉、或隧道断了，都在 5 分钟内自动恢复，不需要人管。
# 前提：各 unit 都设了 StartLimitIntervalSec=0，不存在"崩太多次被 systemd 永久放弃"。
LOG=/var/log/waam-watchdog.log
DOMAIN="${1:-guanli.whatspph.com}"
PORT="${WAAM_WEB_PORT:-9527}"
ts() { date -u '+%F %T'; }
say() { echo "[$(ts)] $*" | tee -a "$LOG"; }

healed=0
UA='Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0'

# 1) 服务进程不在 → 拉起
for u in waam cloudflared cloudflared-b; do
  st=$(systemctl is-active "$u" 2>/dev/null)
  if [ "$st" != "active" ]; then
    say "服务 $u 状态=$st，执行 restart"
    systemctl restart "$u" >>"$LOG" 2>&1
    sleep 3
    say "  -> 现在状态: $(systemctl is-active "$u" 2>/dev/null)"
    healed=1
  fi
done

# 2) 本机 HTTP 不通 → 重启 waam
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' \
  -H "X-Browser-Fp: $(printf 'a%.0s' $(seq 1 64))" -H "User-Agent: $UA" \
  "http://127.0.0.1:${PORT}/" 2>/dev/null)
if [ "$code" != "200" ]; then
  say "本机 :${PORT} 返回 $code，重启 waam"
  systemctl restart waam >>"$LOG" 2>&1
  sleep 20
  code2=$(curl -s -o /dev/null -m 10 -w '%{http_code}' \
    -H "X-Browser-Fp: $(printf 'a%.0s' $(seq 1 64))" -H "User-Agent: $UA" \
    "http://127.0.0.1:${PORT}/" 2>/dev/null)
  say "  -> 重启后本机返回 $code2"
  healed=1
fi

# 3) 主隧道外网不通 → 重启 cloudflared（备用隧道单独判断，避免误动）
pub=$(curl -s -m 20 -o /tmp/wd-body -w '%{http_code}' -H "User-Agent: $UA" "https://${DOMAIN}/" 2>/dev/null)
if [ "$pub" != "200" ]; then
  err=$(grep -oiE 'error code: [0-9]+' /tmp/wd-body 2>/dev/null | head -1)
  say "外网 https://${DOMAIN} 返回 $pub ${err}，重启主隧道 cloudflared"
  systemctl restart cloudflared >>"$LOG" 2>&1
  sleep 25
  pub2=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "User-Agent: $UA" "https://${DOMAIN}/" 2>/dev/null)
  say "  -> 重启后外网返回 $pub2"
  healed=1
fi

# 4) 备用隧道外网不通 → 重启 cloudflared-b（不影响主域名，安全）
pub2d=$(curl -s -m 20 -o /dev/null -w '%{http_code}' -H "User-Agent: $UA" "https://guanli2.whatspph.com/" 2>/dev/null)
if [ "$pub2d" != "200" ]; then
  say "备用外网 https://guanli2.whatspph.com 返回 $pub2d，重启 cloudflared-b"
  systemctl restart cloudflared-b >>"$LOG" 2>&1
  healed=1
fi

if [ "$healed" -eq 0 ]; then
  say "OK 服务与隧道均正常（本机 $code / 主 $pub / 备 $pub2d）"
fi
rm -f /tmp/wd-body
exit 0
