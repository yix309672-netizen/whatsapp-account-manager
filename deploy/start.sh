#!/bin/sh
# WAAM 启动包装脚本
#
# 职责：
#  1) 启动虚拟显示 Xvfb（Electron 需要 X11，但服务器没有桌面）
#  2) 把停止信号**只转发给 Electron**，并等它优雅退出（它会关闭所有 Chrome）
#
# ⚠️ 为什么不用 xvfb-run（实测踩坑，两个坑叠加）：
#  a) xvfb-run 收到 SIGTERM 只退出自身，**不转发**给 Electron 子进程 →
#     Electron 收不到信号，不走优雅退出，它拉起的 Chrome（detached + unref）
#     全部变孤儿进程常驻内存。
#  b) 即使我们在外层转发信号，xvfb-run 一退出就会杀掉 Xvfb；X server 消失后
#     Electron 直接崩，根本没机会跑完清理（实测只清掉 3 个 Chrome，其余被强杀残留）。
#  所以这里自己起 Xvfb：停止时只通知 Electron，Xvfb 等 Electron 退出后再收掉。
#
# 注意：xvfb-run 的 -s/--server-args 在 Ubuntu 上也会拆词（报 184: 0: not found），
# 自己起 Xvfb 顺便绕开了这个坑。
export XAUTHORITY=/run/waam-xauthority
DISPLAY_NUM="${WAAM_XVFB_DISPLAY:-:99}"

XVFB_PID=""
ELECTRON_PID=""
STOPPING=""

forward() {
  sig="$1"
  STOPPING="$sig"
  echo "[start.sh] received SIG$sig, forwarding to electron ${ELECTRON_PID:-?}"
  if [ -n "$ELECTRON_PID" ] && kill -0 "$ELECTRON_PID" 2>/dev/null; then
    kill "-$sig" "$ELECTRON_PID" 2>/dev/null || true
  fi
}

trap 'forward TERM' TERM
trap 'forward INT' INT
trap 'forward HUP' HUP

# 启动虚拟显示。
# 不启用 -auth/xauth：本机同一用户运行的 X 客户端，省掉 cookie 管理更少出错。
unset XAUTHORITY
rm -f "/tmp/.X${DISPLAY_NUM#:}-lock" 2>/dev/null || true
/usr/bin/Xvfb "$DISPLAY_NUM" -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!
sleep 1

if ! kill -0 "$XVFB_PID" 2>/dev/null; then
  echo "[start.sh] Xvfb failed to start on $DISPLAY_NUM"
  exit 1
fi
echo "[start.sh] Xvfb pid=$XVFB_PID display=$DISPLAY_NUM"

# 启动 Electron（前台子进程，便于等待与转发信号）
DISPLAY="$DISPLAY_NUM" /opt/waam/app/node_modules/electron/dist/electron \
  /opt/waam/app \
  --no-sandbox \
  --user-data-dir=/var/lib/waam &
ELECTRON_PID=$!
echo "[start.sh] electron pid=$ELECTRON_PID"

# 轮询等待：即使 wait 被信号打断，也继续等 Electron 自己清理完
while kill -0 "$ELECTRON_PID" 2>/dev/null; do
  sleep 1
done

EXIT_CODE=0
wait "$ELECTRON_PID" 2>/dev/null || EXIT_CODE=$?
echo "[start.sh] electron exited with $EXIT_CODE (stopping=${STOPPING:-no})"

# Electron 已退出（Chrome 已由它自己清理），再收掉 Xvfb
if [ -n "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null; then
  kill -TERM "$XVFB_PID" 2>/dev/null || true
  sleep 1
  kill -KILL "$XVFB_PID" 2>/dev/null || true
fi
echo "[start.sh] exited"
exit "$EXIT_CODE"
