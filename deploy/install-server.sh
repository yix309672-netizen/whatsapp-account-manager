#!/usr/bin/env bash
# ============================================================================
# WhatsApp 账号管理器 —— Ubuntu/Debian 云服务器一键部署
#
# 做的事：
#   1. 装依赖：xvfb（Electron 无桌面也要一个虚拟显示）、Chrome（whatsapp-web.js 必需）、
#      编译工具（better-sqlite3 原生模块）
#   2. 装 Node 20（electron-vite 构建用；Node 26 无法编译 better-sqlite3）
#   3. 从 git 拉代码到 /opt/waam/app（或复用已有目录）
#   4. npm install + electron-vite build 产出 dist/
#   5. 写 /etc/waam.env（管理员密码等）、装 systemd 服务并启动
#
# 用法（在服务器上，root）：
#   bash deploy/install-server.sh                 # 交互式
#   WAAM_ADMIN_PASSWORD='你的强密码' bash deploy/install-server.sh
#   REPO_URL=... APP_DIR=... bash deploy/install-server.sh
# ============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/yix309672-netizen/whatsapp-account-manager.git}"
APP_DIR="${APP_DIR:-/opt/waam/app}"
PORT="${WAAM_WEB_PORT:-9527}"
NODE_MAJOR="${NODE_MAJOR:-20}"
SERVICE_USER="${SERVICE_USER:-root}"

log()  { printf '\033[32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo bash $0）"

# ---------------------------------------------------------------- 管理员密码
if [[ -z "${WAAM_ADMIN_PASSWORD:-}" ]]; then
  if [[ -f /etc/waam.env ]] && grep -q '^WAAM_ADMIN_PASSWORD=' /etc/waam.env; then
    WAAM_ADMIN_PASSWORD="$(grep '^WAAM_ADMIN_PASSWORD=' /etc/waam.env | head -1 | cut -d= -f2-)"
    log "复用 /etc/waam.env 里已有的管理员密码"
  else
    read -r -s -p "设置管理器管理员密码（登录用户名固定为「小易」）: " WAAM_ADMIN_PASSWORD || true
    echo
    [[ -n "$WAAM_ADMIN_PASSWORD" ]] || die "密码不能为空"
  fi
fi

# ---------------------------------------------------------------- 1. 系统依赖
log "安装系统依赖（xvfb / Chrome / 编译工具 / git / curl）..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git xvfb build-essential python3 \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 \
  fonts-liberation libappindicator3-1 >/dev/null

if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1; then
  log "安装 Google Chrome..."
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  apt-get install -y -qq google-chrome-stable >/dev/null
else
  log "Chrome 已存在，跳过"
fi

# ---------------------------------------------------------------- 2. Node 20
need_node=1
if command -v node >/dev/null 2>&1; then
  cur="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [[ "$cur" == "$NODE_MAJOR" ]]; then need_node=0; log "Node $(node -v) 已符合要求"; fi
fi
if [[ $need_node -eq 1 ]]; then
  log "安装 Node ${NODE_MAJOR}.x（NodeSource）..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

# ---------------------------------------------------------------- 3. 拉代码
mkdir -p "$(dirname "$APP_DIR")"
if [[ -d "$APP_DIR/.git" ]]; then
  log "更新已有代码 $APP_DIR"
  git -C "$APP_DIR" fetch --all -q && git -C "$APP_DIR" reset --hard origin/main -q
else
  log "克隆代码到 $APP_DIR"
  git clone -q "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# ---------------------------------------------------------------- 4. 构建
log "安装 npm 依赖（含 better-sqlite3 本地编译）..."
npm install --no-audit --no-fund

log "构建 main/preload/renderer 到 dist/ ..."
npx electron-vite build

[[ -f dist/renderer/index.html ]] || die "构建失败：dist/renderer/index.html 不存在"
[[ -f dist/main/index.js ]] || die "构建失败：dist/main/index.js 不存在"

# ---------------------------------------------------------------- 5. 环境文件
log "写入 /etc/waam.env ..."
cat > /etc/waam.env <<EOF
# 管理器 Web 后台配置（改完记得 systemctl restart waam）
WAAM_WEB_PORT=${PORT}
WAAM_WEB_HOST=0.0.0.0
WAAM_ADMIN_PASSWORD=${WAAM_ADMIN_PASSWORD}
# 服务器场景关闭反调试轮询（省掉每 5 秒一次 powershell/进程查询）
WAAM_ANTIDEBUG=0
# 控制台不写日志（日志仍落 dist 之外的 userData/logs），避免 systemd 管道噪音
WAAM_NO_CONSOLE=0
# root 运行 Chrome 必须 --no-sandbox（非 root 可删）
WAAM_CHROME_NO_SANDBOX=1
EOF
chmod 600 /etc/waam.env
log "已写入 /etc/waam.env（权限 600）"

# ---------------------------------------------------------------- 6. systemd
log "安装 systemd 服务..."
install -m 0644 "$APP_DIR/deploy/waam.service" /etc/systemd/system/waam.service
# 服务文件里的默认值，按本次参数覆盖
sed -i "s#^WorkingDirectory=.*#WorkingDirectory=${APP_DIR}#" /etc/systemd/system/waam.service
sed -i "s#^ExecStart=.*#ExecStart=/usr/bin/xvfb-run -a -s \"-screen 0 1920x1080x24\" ${APP_DIR}/node_modules/electron/dist/electron ${APP_DIR} --no-sandbox --user-data-dir=/var/lib/waam#" /etc/systemd/system/waam.service
sed -i "s#^User=.*#User=${SERVICE_USER}#" /etc/systemd/system/waam.service

mkdir -p /var/lib/waam
systemctl daemon-reload
systemctl enable waam >/dev/null
systemctl restart waam

# ---------------------------------------------------------------- 7. 自检
log "等待服务起来..."
for i in $(seq 1 30); do
  if curl -fsS -m 3 -H "X-Browser-Fp: $(printf 'a%.0s' {1..64})" \
      -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0" \
      "http://127.0.0.1:${PORT}/api/captcha" >/dev/null 2>&1; then
    log "服务已就绪：http://127.0.0.1:${PORT}"
    break
  fi
  sleep 2
  [[ $i -eq 30 ]] && warn "30 次探测仍未就绪，请看：journalctl -u waam -n 80 --no-pager"
done

IP="$(curl -fsS -m 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
cat <<EOF

============================================================
 部署完成
   管理地址   http://${IP}:${PORT}
   登录用户名 小易
   登录密码   （就是你刚才输入的那个，存在 /etc/waam.env）
   数据目录   /var/lib/waam（数据库、Chrome 配置、WhatsApp 会话、日志）
   服务管理   systemctl status|restart|stop waam
   实时日志   journalctl -u waam -f
============================================================
EOF

# 防火墙提示
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  warn "检测到 ufw 已开启，如需直接访问端口请执行：ufw allow ${PORT}/tcp（更推荐只放行 80/443 走 Nginx）"
fi
