#!/usr/bin/env bash
# ============================================================================
# WhatsApp Account Manager -- Ubuntu/Debian cloud server deployment (one shot)
#
# What it does:
#   1. apt deps: xvfb (Electron needs an X display even without a desktop),
#      Google Chrome (whatsapp-web.js needs it), build tools for better-sqlite3
#   2. Node 20 from the official tarball (Node 22+ has no better-sqlite3 9.x
#      prebuild / build support here)
#   3. git clone (or update) the repo into APP_DIR
#   4. npm install + rebuild better-sqlite3 against the ELECTRON ABI
#      (plain `npm install` gives the Node ABI -> "NODE_MODULE_VERSION 115 vs 123")
#   5. electron-vite build -> dist/
#   6. /etc/waam.env + /usr/share/waam/start.sh + systemd unit, service started
#
# Usage (root, on the server):
#   WAAM_ADMIN_PASSWORD='your-strong-password' bash deploy/install-server.sh
#   REPO_URL=... APP_DIR=... WAAM_WEB_PORT=... bash deploy/install-server.sh
#
# Optional: set TUNNEL=1 to also install cloudflared and start a quick tunnel.
# ============================================================================
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/yix309672-netizen/whatsapp-account-manager.git}"
APP_DIR="${APP_DIR:-/opt/waam/app}"
PORT="${WAAM_WEB_PORT:-9527}"
NODE_VER="${NODE_VER:-20.11.1}"
DATA_DIR="${DATA_DIR:-/var/lib/waam}"
ELECTRON_VER="${ELECTRON_VER:-30.5.1}"
TUNNEL="${TUNNEL:-0}"

log()  { printf '\033[32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"

# ---------------------------------------------------------------- admin password
if [[ -z "${WAAM_ADMIN_PASSWORD:-}" ]]; then
  if [[ -f /etc/waam.env ]] && grep -q '^WAAM_ADMIN_PASSWORD=' /etc/waam.env; then
    WAAM_ADMIN_PASSWORD="$(grep '^WAAM_ADMIN_PASSWORD=' /etc/waam.env | head -1 | cut -d= -f2-)"
    log "reusing admin password from /etc/waam.env"
  elif [[ -f "${DATA_DIR}/web-admin-password.txt" ]]; then
    warn "database already initialised and no WAAM_ADMIN_PASSWORD given."
    warn "the admin password stays whatever it was; read it with:"
    warn "  cat ${DATA_DIR}/web-admin-password.txt"
    WAAM_ADMIN_PASSWORD=""
  else
    read -r -s -p "admin password for user 小易: " WAAM_ADMIN_PASSWORD || true
    echo
    [[ -n "$WAAM_ADMIN_PASSWORD" ]] || die "password must not be empty"
  fi
fi

# ---------------------------------------------------------------- 1. apt deps
log "1/7 apt deps"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git xvfb build-essential python3 >/dev/null

# ---------------------------------------------------------------- 2. Node 20
log "2/7 Node ${NODE_VER}"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" != "20" ]]; then
  cd /usr/local
  curl -fsSL -o node.tar.xz "https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-x64.tar.xz"
  tar -xJf node.tar.xz
  rm -f node.tar.xz
  for b in node npm npx; do ln -sf "/usr/local/node-v${NODE_VER}-linux-x64/bin/${b}" "/usr/local/bin/${b}"; done
fi
node -v

# ---------------------------------------------------------------- 3. Chrome
log "3/7 Google Chrome"
if ! command -v google-chrome >/dev/null 2>&1; then
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -qq
  apt-get install -y -qq google-chrome-stable >/dev/null
fi
google-chrome --version

log "4/7 Electron runtime libs"
apt-get install -y -qq libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 \
  libpango-1.0-0 libcairo2 fonts-liberation >/dev/null

# ---------------------------------------------------------------- 4. code
log "5/7 code into ${APP_DIR}"
mkdir -p "$(dirname "$APP_DIR")"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch --all -q
  git -C "$APP_DIR" reset --hard origin/main -q
else
  git clone -q "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
git log --oneline -1

# ---------------------------------------------------------------- 5. build
log "6/7 npm install + electron ABI rebuild + build"
npm install --no-audit --no-fund --loglevel=error
# critical: better-sqlite3 must match Electron's ABI, not Node's
npm_config_runtime=electron \
npm_config_target="$ELECTRON_VER" \
npm_config_disturl=https://electronjs.org/headers \
  npm rebuild better-sqlite3 --foreground-scripts >/dev/null
npx electron-vite build 2>&1 | tail -3
[[ -f dist/renderer/index.html && -f dist/main/index.js ]] || die "build output missing"

# ---------------------------------------------------------------- 6. env + unit
log "7/7 env file, launcher, systemd unit"
mkdir -p "$DATA_DIR"
{
  echo "WAAM_WEB_PORT=${PORT}"
  echo "WAAM_WEB_HOST=0.0.0.0"
  echo "WAAM_ANTIDEBUG=0"
  echo "WAAM_NO_CONSOLE=0"
  echo "WAAM_CHROME_NO_SANDBOX=1"
  [[ -n "$WAAM_ADMIN_PASSWORD" ]] && echo "WAAM_ADMIN_PASSWORD=${WAAM_ADMIN_PASSWORD}"
} > /etc/waam.env
chmod 600 /etc/waam.env

mkdir -p /usr/share/waam
cat > /usr/share/waam/start.sh <<EOF
#!/bin/sh
# Generated by deploy/install-server.sh
# NOTE: never pass -s/--server-args to xvfb-run here. Ubuntu's xvfb-run execs
# with unquoted \$@, so a -s value gets word-split and destroys the command
# arguments. The default 1280x1024x24 screen is enough: WhatsApp itself runs
# headless through the CDP endpoint.
export XAUTHORITY=/run/waam-xauthority
exec /usr/bin/xvfb-run -a -f /run/waam-xauth \\
  ${APP_DIR}/node_modules/electron/dist/electron \\
  ${APP_DIR} \\
  --no-sandbox \\
  --user-data-dir=${DATA_DIR}
EOF
chmod +x /usr/share/waam/start.sh

cat > /etc/systemd/system/waam.service <<'EOF'
[Unit]
Description=WhatsApp Account Manager (Web)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/waam.env
Environment=DISPLAY=:99
Environment=ELECTRON_DISABLE_SECURITY_WARNINGS=1
ExecStart=/usr/share/waam/start.sh
User=root
Restart=always
RestartSec=5
LimitNOFILE=65535
KillMode=mixed
TimeoutStopSec=20
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable waam >/dev/null
systemctl restart waam

# ---------------------------------------------------------------- health check
log "waiting for the web server..."
for i in $(seq 1 30); do
  if curl -fsS -m 3 -H "X-Browser-Fp: $(printf 'a%.0s' {1..64})" \
      -H "User-Agent: Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0" \
      "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    log "web manager is up on port ${PORT}"
    break
  fi
  sleep 2
  [[ $i -eq 30 ]] && warn "not ready after 60s: journalctl -u waam -n 80 --no-pager"
done

if [[ "$TUNNEL" == "1" ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    log "installing cloudflared"
    cd /tmp
    curl -fsSL -o cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
    dpkg -i cloudflared.deb >/dev/null 2>&1 || apt-get install -y -qq -f >/dev/null
  fi
  systemctl reset-failed waam-tunnel-quick 2>/dev/null || true
  systemd-run --unit=waam-tunnel-quick --collect \
    /usr/local/bin/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" >/dev/null 2>&1 || true
  sleep 15
  URL="$(journalctl -u waam-tunnel-quick --no-pager 2>/dev/null | grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' | head -1 || true)"
  [[ -n "$URL" ]] && log "quick tunnel: ${URL}"
fi

cat <<EOF

============================================================
 deployed
   local URL    http://127.0.0.1:${PORT}
   admin user   小易
   admin pass   $( [[ -n "$WAAM_ADMIN_PASSWORD" ]] && echo "the one you supplied (also in /etc/waam.env)" || echo "see ${DATA_DIR}/web-admin-password.txt" )
   data dir     ${DATA_DIR}
   service      systemctl status|restart|stop waam
   logs         journalctl -u waam -f
 self check
   node deploy/selfcheck.mjs http://127.0.0.1:${PORT} 小易 <password>
============================================================
EOF
