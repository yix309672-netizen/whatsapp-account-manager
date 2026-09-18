#!/usr/bin/env bash
# 隧道可用性监测：周期性探测外网入口，记录非 200 / 1033 / 530 等失败
# 用法: bash deploy/tunnel-monitor.sh [域名] [间隔秒] [总时长秒]
DOMAIN="${1:-guanli.whatspph.com}"
INTERVAL="${2:-30}"
DURATION="${3:-21600}"   # 默认 6 小时
LOG=/var/log/waam-tunnel-monitor.log
UA='Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0'

echo "=== monitor start $(date -u '+%F %T') domain=$DOMAIN interval=${INTERVAL}s duration=${DURATION}s ===" | tee -a "$LOG"
total=0; fail=0
end=$(( $(date +%s) + DURATION ))
while [ "$(date +%s)" -lt "$end" ]; do
  ts=$(date -u '+%F %T')
  body=$(curl -s -m 20 -w '\n__CODE__%{http_code}__TIME__%{time_total}' \
    -H "User-Agent: $UA" "https://${DOMAIN}/" 2>/dev/null)
  code=$(echo "$body" | sed -n 's/.*__CODE__\([0-9]*\)__TIME__.*/\1/p')
  t=$(echo "$body" | sed -n 's/.*__CODE__[0-9]*__TIME__\([0-9.]*\).*/\1/p')
  total=$((total+1))
  if [ "$code" != "200" ]; then
    fail=$((fail+1))
    snippet=$(echo "$body" | grep -oiE 'error code: [0-9]+' | head -1)
    echo "[$ts] FAIL http=$code time=${t}s ${snippet}" | tee -a "$LOG"
    # 失败时补充现场证据
    echo "[$ts]   cloudflared=$(systemctl is-active cloudflared) waam=$(systemctl is-active waam) load=$(cut -d' ' -f1-3 /proc/loadavg) mem=$(free -m | awk '/^Mem:/{print $3"/"$2"MB"}')" | tee -a "$LOG"
  else
    # 正常也定期记一条心跳，便于确认监测本身没死
    if [ $((total % 20)) -eq 0 ]; then
      echo "[$ts] ok http=200 time=${t}s (已探测 $total 次, 失败 $fail 次)" | tee -a "$LOG"
    fi
  fi
  sleep "$INTERVAL"
done
echo "=== monitor done $(date -u '+%F %T') total=$total fail=$fail ===" | tee -a "$LOG"
