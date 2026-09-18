#!/usr/bin/env bash
# WAAM 巡检：给出一份不用登录网页就能判断"掉没掉线"的报告
# 用法: bash deploy/healthcheck.sh [域名]
DOMAIN="${1:-guanli.whatspph.com}"
PORT="${WAAM_WEB_PORT:-9527}"
ok=0; bad=0
chk() { if [ "$1" = "0" ]; then printf '  [OK]   %s\n' "$2"; ok=$((ok+1)); else printf '  [FAIL] %s\n' "$2"; bad=$((bad+1)); fi; }

echo "===== WAAM healthcheck  $(date -u '+%Y-%m-%d %H:%M:%S UTC') ====="

echo "[1] systemd services"
for s in waam cloudflared; do
  active=$(systemctl is-active "$s" 2>/dev/null)
  enabled=$(systemctl is-enabled "$s" 2>/dev/null)
  restarts=$(systemctl show "$s" -p NRestarts --value)
  [ "$active" = "active" ] && chk 0 "$s active ($enabled, restarts=$restarts)" || chk 1 "$s NOT active (state=$active)"
done

echo "[2] process uptime (服务是否中途重启过)"
for p in electron Xvfb cloudflared; do
  line=$(ps -eo etimes,comm,args --sort=-etimes | grep -E "[ /]$p( |$)" | head -1)
  if [ -n "$line" ]; then
    secs=$(echo "$line" | awk '{print $1}')
    h=$((secs/3600)); m=$(((secs%3600)/60))
    chk 0 "$p 已运行 ${h}h${m}m"
  else
    chk 1 "$p 进程不存在"
  fi
done

echo "[3] local HTTP"
code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' \
  -H "X-Browser-Fp: $(printf 'a%.0s' $(seq 1 64))" \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0' \
  "http://127.0.0.1:${PORT}/")
[ "$code" = "200" ] && chk 0 "本机 http://127.0.0.1:${PORT} -> 200" || chk 1 "本机返回 $code"

echo "[4] public HTTPS (${DOMAIN})"
code=$(curl -s -o /dev/null -m 20 -w '%{http_code}' \
  -H 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0' \
  "https://${DOMAIN}/")
[ "$code" = "200" ] && chk 0 "https://${DOMAIN} -> 200" || chk 1 "外网返回 $code"

echo "[5] login + websocket 全链路"
[ -f /opt/waam/health-cred ] && SELFCHECK_CRED=1 || SELFCHECK_CRED=0
if [ "$SELFCHECK_CRED" = "1" ]; then
  out=$(cd /opt/waam/app && node deploy/selfcheck.mjs "https://${DOMAIN}" "$(awk 'NR==1{print $1}' /opt/waam/health-cred)" "$(awk 'NR==1{print $2}' /opt/waam/health-cred)" 2>&1 | tail -2)
  echo "$out" | grep -q '6/6' && chk 0 "登录 + 6 条 WS 命令全部成功" || chk 1 "自检未通过: $(echo "$out" | tr '\n' ' ')"
else
  echo "  [SKIP] 没配 /opt/waam/health-cred（内容：用户名 密码），跳过登录自检"
fi

echo "[6] resources"
mem=$(free -m | awk '/^Mem:/{printf "%d/%dMB", $3, $2}')
disk=$(df -h / | awk 'NR==2{print $5}')
chrome=$(pgrep -c chrome 2>/dev/null)
chrome=${chrome:-0}
load=$(cut -d' ' -f1 /proc/loadavg)
chk 0 "内存 $mem, 磁盘 $disk, Chrome 进程 $chrome, load $load"

echo "[7] recent errors (last 200 log lines)"
# 只统计"运行期"错误：排除已知无害噪音
#  - viz_main_impl / GPU process：headless 无 GPU，Chromium 正常回退
#  - bus.cc：容器/无桌面环境连不上 dbus
#  - Main process exited / Scheduled restart：那是我们主动重启的记录，不是崩溃
#  - xkbcomp：自己起 Xvfb 时的键盘映射提示，X server 明说 "not fatal"
errs=$(journalctl -u waam --no-pager -n 200 2>/dev/null \
  | grep -iE 'error|fatal|crash' \
  | grep -viE 'viz_main_impl|bus.cc|GPU process|Main process exited|Failed with result|Scheduled restart|xkbcomp|not fatal' \
  | wc -l)
[ "${errs:-0}" -eq 0 ] && chk 0 "运行期错误 0 行（已知无害噪音已排除）" || chk 1 "运行期错误 $errs 行（需人工看）"

echo "======================================"
echo " 通过 $ok 项，失败 $bad 项"
[ "$bad" -eq 0 ] && echo " 结论：管理端在线，无异常" || echo " 结论：有 $bad 项异常，见上面 [FAIL]"
exit "$bad"
