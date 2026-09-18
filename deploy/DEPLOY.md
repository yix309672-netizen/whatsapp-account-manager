# 部署到 Linux 云服务器（Ubuntu / Debian）

> 本文是这次从零跑通后写的实操手册，命令都验证过。管理器本身是 Electron 应用，
> 「服务器模式」= 不带窗口常驻后台 + 内置 Web 后台（默认 `9527`），浏览器远程用全部管理功能。

---

## 0. 先搞清楚它到底是什么

| 角色 | 说明 |
|---|---|
| 管理器（本仓库） | Electron 主进程常驻，内置 HTTP + WebSocket 服务（`src/main/web/server.ts`），浏览器操作全部管理功能 |
| 登录用户名 | 默认 **xiaoyi**（首次建库时写入 `admin_users`，可用 `WAAM_ADMIN_USER` 改；库里已有账号后改环境变量无效，需直接改库或走改密码接口） |
| 登录密码 | 首次启动时取环境变量 `WAAM_ADMIN_PASSWORD`，没有就随机生成写入 `userData/web-admin-password.txt` |
| 数据目录 | 数据库 `accounts.db`、Chrome 配置、WhatsApp 会话、日志、导出文件都在 Electron 的 `userData` 目录 |
| Chrome | 每个账号一个独立 Chrome 实例（`ChromeLauncher.ts`），**服务器必须装 Chrome**，浏览器本身是 headless 跑的 |
| 员工端 | 员工用的 `kuai-z` 通过中转（Cloudflare Worker relay）连回管理器；自建中转见 `cloudflare-worker/` |

## 1. 环境要求

- Ubuntu 20.04 / 22.04 / 24.04 或 Debian 11+，root 或 sudo
- 至少 2 核 4G 内存（每个已登录账号一个 Chrome，1 个账号约 300–500MB）
- 磁盘 20G+（Chrome 配置 + WhatsApp 缓存会长）
- 能科学/稳定访问 `web.whatsapp.com`（国内服务器需自行解决出口）
- **没有桌面的服务器也要装 xvfb**：Electron 主进程需要 X11，哪怕它不开窗口

## 2. 一键部署

```bash
# 上传或直接在服务器上拉脚本
git clone https://github.com/yix309672-netizen/whatsapp-account-manager.git /opt/waam/app
cd /opt/waam/app

# 交互式（会问你要管理员密码）
sudo bash deploy/install-server.sh

# 或非交互
sudo WAAM_ADMIN_PASSWORD='换成你的强密码' bash deploy/install-server.sh
```

脚本会依次做：装 xvfb/Chrome/编译工具 → 装 Node 20 → 拉代码 → `npm install` →
`electron-vite build` → 写 `/etc/waam.env` → 装并启动 systemd 服务 `waam` → 自检端口。

脚本可用环境变量覆盖：`REPO_URL`、`APP_DIR`、`WAAM_WEB_PORT`、`NODE_MAJOR`、`SERVICE_USER`。

## 3. 部署后自检

```bash
systemctl status waam                    # 应为 active (running)
journalctl -u waam -n 80 --no-pager      # 看启动日志
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:9527/     # 期望 200
```

浏览器打开 `http://服务器IP:9527`（若服务商封了端口，见第 4 节走隧道）：

- [ ] 登录页出现，带图形验证码
- [ ] 错密码被拒（连续 5 次会封 30 分钟，这是设计如此）
- [ ] 用「xiaoyi + 你设的密码」进入管理器
- [ ] 账号列表能加载（空列表也正常）
- [ ] 新建账号 → 登录 → 出二维码/配对码
- [ ] `systemctl restart waam` 后无需重新登录（登录态落盘 7 天）

> 提示：页面静态资源和 API 都在 `9527`，但**前端所有命令都走 WebSocket `/ws`**。
> 如果你的反向代理没转发 `Upgrade` 头，会出现「页面能开、点什么都转圈」——用 `deploy/nginx-waam.conf`。

## 4. 对外访问：域名 + HTTPS

```bash
apt-get install -y nginx
cp deploy/nginx-waam.conf /etc/nginx/sites-available/waam
sed -i 's/guanli.example.com/你的域名/g' /etc/nginx/sites-available/waam
ln -sf /etc/nginx/sites-available/waam /etc/nginx/sites-enabled/waam
nginx -t && systemctl reload nginx

# 证书
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d 你的域名
```

安全建议（强烈）：

1. 只放行 `80/443`，把 `9527` 关在服务器内部：
   `/etc/waam.env` 改 `WAAM_WEB_HOST=127.0.0.1` 后 `systemctl restart waam`
2. 不要在公网裸奔 `9527`（虽然有验证码 + 限流，但没必要）
3. 想更省事可以用 Cloudflare Tunnel 代替 Nginx：`cloudflared tunnel --url http://127.0.0.1:9527`

### 4.1 服务商封了 9527？直接走 Cloudflare Tunnel

很多云服务商对外只开 80/443/22，`9527` 从公网连不上（本机 `Test-NetConnection` 会失败）。
这时不要折腾防火墙，直接上隧道：

```bash
# 装 cloudflared
curl -fsSL -o /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
dpkg -i /tmp/cloudflared.deb

# A) 临时试跑（随机域名，无需账号，适合先看效果）
systemd-run --unit=waam-tunnel-quick --collect \
  /usr/local/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:9527
sleep 15
journalctl -u waam-tunnel-quick --no-pager | grep -o 'https://[a-zA-Z0-9.-]*\.trycloudflare\.com' | head -1

# B) 正式：绑自己的域名（需要浏览器点一次授权）
cloudflared tunnel login                     # 打开它给的 dash.cloudflare.com 链接并 Authorize
cloudflared tunnel create waam               # 生成 tunnel 凭据
cloudflared tunnel route dns waam guanli.你的域名
cat > /etc/cloudflared/config.yml <<'EOF'
tunnel: waam
credentials-file: /root/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: guanli.你的域名
    service: http://127.0.0.1:9527
  - service: http_status:404
EOF
cloudflared service install                  # 装成 systemd 服务（开机自启）
systemctl restart cloudflared
```

访问 `https://guanli.你的域名`（Cloudflare 自带 HTTPS，WebSocket 也会被正常转发）。

### 4.2 用 API Token 建正式隧道（无需浏览器授权）

`cloudflared tunnel login` 需要域名持有者在浏览器点授权。如果你（或运维）手上能拿到
API Token，可以完全用 API 建隧道，不用点浏览器：

1. Cloudflare 后台 → My Profile → API Tokens → Create Token，权限：
   - `Account` → `Cloudflare Tunnel` → **Edit**
   - `Zone` → `DNS` → **Edit**（Zone 选你的域名，如 `whatspph.com`）

2. 拿真实的 **Account ID**：`GET /client/v4/zones/<zone_id>` 里的 `result.account.id`
   ⚠️ 不要凭 token 前缀猜账号 ID（实测猜错会一路 403，很难看出原因）。

3. 建隧道（注意 `config_src=cloudflare` 表示 ingress 走**远端配置**）：
   ```bash
   curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/cfd_tunnel" \
     -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
     -d '{"name":"waam-server","config_src":"cloudflare"}'
   # 响应里的 .result.id 是隧道 ID，.result.token 是 cloudflared 用的 token（240 字符）
   ```

4. 下发 ingress（`connectTimeout` 必须是**数字**，写成 `"30s"` 会报
   `strconv.ParseInt: parsing "\"30s\"": invalid syntax`）：
   ```bash
   curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/cfd_tunnel/$TID/configurations" \
     -H "Authorization: Bearer $CF_TOKEN" -H 'Content-Type: application/json' \
     -d '{"config":{"ingress":[
           {"hostname":"guanli.whatspph.com","service":"http://127.0.0.1:9527","originRequest":{"connectTimeout":30}},
           {"service":"http_status:404"}]}}'
   ```

5. DNS 指向隧道：
   ```bash
   # 找到已有记录 id
   curl -s "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records?name=guanli.whatspph.com" \
     -H "Authorization: Bearer $CF_TOKEN"
   # 改成 CNAME -> <隧道ID>.cfargotunnel.com，proxied=true
   ```

6. 服务器上装服务（**不要**再放本地 `config.yml`！）：
   ```bash
   cloudflared service install --no-update-service "<240字符token>"
   systemctl enable --now cloudflared
   ```
   ⚠️ 本地 `/etc/cloudflared/config.yml` 里写 `tunnel: <id>` 会和 token 里的隧道冲突，
   实测会变成边缘报 `error code: 1033`（边缘不知道这个隧道）。用 token 时只保留 token 文件，
   本地 config 改名备份即可。

7. **配置生效有几秒到几十秒延迟**：刚下发完立刻访问可能还是 `530 / 1033`，等 10–30 秒再试。

## 5. 环境变量一览（`/etc/waam.env`）

| 变量 | 默认 | 说明 |
|---|---|---|
| `WAAM_WEB_PORT` | `9527` | Web 后台端口 |
| `WAAM_WEB_HOST` | `0.0.0.0` | 监听地址，只走反代时设 `127.0.0.1` |
| `WAAM_ADMIN_USER` | `xiaoyi` | 首次建库时的管理员用户名 |
| `WAAM_ADMIN_PASSWORD` | 空 | 首次建库时的管理员密码；库里已有账号后改这个**不会**改密码，要改走后台改密码接口 |
| `WAAM_ANTIDEBUG` | 开 | `0` 关闭反调试轮询（服务器建议关，省掉每 5 秒一次进程探测） |
| `WAAM_NO_CONSOLE` | 开 | `1` 完全不写控制台输出（日志仍写文件） |
| `WAAM_CHROME_NO_SANDBOX` | 自动 | root 运行时自动加 `--no-sandbox`；也可手动 `1`/`0` |

## 6. 日常运维

```bash
systemctl restart waam          # 重启
journalctl -u waam -f           # 实时日志
tail -f /var/lib/waam/logs/app-$(date +%F).log     # 应用日志（更全）
systemctl disable --now waam    # 停用
```

### 6.1 巡检：一条命令看"掉没掉线"

```bash
bash deploy/healthcheck.sh                    # 默认查 https://guanli.whatspph.com
bash deploy/healthcheck.sh 你的域名
```

它会依次检查：两个 systemd 服务的状态/自启/重启次数 → 进程运行时长（判断是否中途重启过）→
本机 9527 → 外网 HTTPS → 真实登录 + WebSocket 6 条命令 → 内存/磁盘/Chrome 数 → 运行期错误行。
最后给出「通过 N 项 / 失败 N 项」和结论，退出码 = 失败项数（可挂 crontab 告警）。

想做登录自检，先放一份凭据（600 权限，别写进仓库）：

```bash
printf 'xiaoyi 你的密码' > /opt/waam/health-cred
chmod 600 /opt/waam/health-cred
```

挂到 crontab 每 10 分钟巡检一次、失败写日志：

```bash
echo '*/10 * * * * bash /opt/waam/app/deploy/healthcheck.sh >> /var/log/waam-health.log 2>&1' | crontab -
```

### 6.2 24 小时常驻的关键设置（都已配好）

| 设置 | 值 | 为什么 |
|---|---|---|
| `Restart=always` + `RestartSec=5` | 已配 | 进程挂掉 5 秒内自动拉起 |
| `StartLimitIntervalSec=0` | 已配 | **systemd 默认 10 秒内崩 5 次就永久放弃拉起**；无人值守服务必须关掉这个限制 |
| `systemctl enable` | 已配 | 服务器重启后自动启动 |
| 登录态落盘 | 已配 | token 存 `userData/web-sessions.json`，有效期 7 天，重启不用重新登录 |
| `WAAM_ANTIDEBUG=0` | 已配 | 免掉每 5 秒一次的反调试探测（Windows 版会 spawn powershell，服务器上纯浪费） |
| 控制台 EPIPE 兜底 | 已配 | stdout 管道断了也不会把请求卡死（见 7.1 第 4 条） |
| 会话健康检查 | 代码内置 | 每 30 秒探活，掉线按 3s×2ⁿ 退避重连，最多 5 次 |
| 磁盘维护 | 代码内置 | 每 6 小时清理：导出文件 7 天、结束的筛号任务 30 天、活跃度缓存 90 天 |

### 6.3 更新代码时的正确顺序（重要）

`npm install` / `npm rebuild` 会**覆盖** `node_modules/better-sqlite3/build/Release/*.node`，
而正在运行的进程还映射着旧文件 —— 实测会直接把进程打成段错误（`status=139`）。
所以升级必须**先停服务**：

```bash
systemctl stop waam                 # ← 必须先停，别在运行中重建原生模块
cd /opt/waam/app
git pull
npm install --no-audit --no-fund
npm_config_runtime=electron npm_config_target=30.5.1 \
  npm_config_disturl=https://electronjs.org/headers \
  npm rebuild better-sqlite3 --foreground-scripts
npx electron-vite build
systemctl start waam
bash deploy/healthcheck.sh          # 确认起来了
```

### 6.4 已知容量边界

- **开机自动恢复会话上限 10 个账号**（`src/main/index.ts:95` 的 `system:auto_restore limit:10`，
  每 12 秒拉起一个）。账号多于 10 个时，重启后只有前 10 个自动上线，其余要手动点登录。
- 每个已登录账号常驻一个 Chrome，约 300–500MB。4GB 内存的机器建议**常驻不超过 5–6 个账号**，
  否则会 OOM 被内核杀（表现出来就是服务反复重启）。
- 单个浏览器会话 token 有效期 7 天，到期需重新登录。

更新到最新代码：

```bash
systemctl stop waam                 # 先停！运行中重建原生模块会段错误（见 6.3）
cd /opt/waam/app
git pull
npm install --no-audit --no-fund
npm_config_runtime=electron npm_config_target=30.5.1 \
  npm_config_disturl=https://electronjs.org/headers \
  npm rebuild better-sqlite3 --foreground-scripts
npx electron-vite build
systemctl start waam
```

备份（数据库 + 会话）：

```bash
systemctl stop waam
tar czf ~/waam-backup-$(date +%F).tar.gz /var/lib/waam
systemctl start waam
```

## 7. 这次为 Linux 改了什么（相对原仓库）

| 文件 | 改动 | 原因 |
|---|---|---|
| `src/main/utils/logger.ts` | `stdout/stderr` 加 EPIPE 兜底、连续失败自动停用控制台输出、致命日志只落文件 | 实测：stdout 管道断开后写日志抛 EPIPE，**会把登录请求卡死**（服务化部署必踩） |
| `src/main/services/ChromeLauncher.ts` | Chrome 路径探测加 Linux 分支；`cleanupStaleChrome` 增加 `ps` 版实现；root 下自动加 `--no-sandbox --disable-dev-shm-usage` | 原来只有 Windows 的 PowerShell 实现，Linux 上清理会报错；root 跑 Chrome 必须 `--no-sandbox` |
| `src/main/utils/security.ts` | 反调试的 Windows 进程探测可用 `WAAM_ANTIDEBUG=0` 关闭 | 服务化后每 5 秒 spawn 一次探测毫无意义还拖慢主进程 |
| `src/main/web/server.ts` | 监听地址可用 `WAAM_WEB_HOST` 配置（默认 `0.0.0.0`） | 方便「只给反代用」时收回到本机 |
| `postcss.config.js` → `postcss.config.cjs` | 改成 CommonJS | 原文件是 ESM `export default`，而 `package.json` 没有 `"type": "module"`，`electron-vite build` 直接报 `Unexpected token 'export'` |

## 7.1 部署时踩到的三个硬坑（已在脚本里处理）

1. **better-sqlite3 的 ABI 必须是 Electron 的，不是 Node 的**
   `npm install` 装出来的是 Node ABI（`NODE_MODULE_VERSION 115`），Electron 30 需要 `123`，
   启动时报 `was compiled against a different Node.js version`。必须补一条：
   ```bash
   npm_config_runtime=electron npm_config_target=30.5.1 \
   npm_config_disturl=https://electronjs.org/headers \
     npm rebuild better-sqlite3 --foreground-scripts
   ```
2. **Ubuntu 24.04 的 `xvfb-run` 不能带 `-s/--server-args`**
   该脚本用未加引号的 `$@` 执行命令，`-s` 的值会被二次拆词，把命令参数全部破坏
   （报 `/usr/bin/xvfb-run: 184: 0: not found`，且 `tries` 被重置导致 10 次重试全废）。
   用默认屏幕参数即可 —— WhatsApp 本身是走 CDP 的 headless Chrome，不需要大屏。
3. **树莓/云服务商常封 9527**，公网连不上不是服务没起来。本机 `curl 127.0.0.1:9527` 能通
   就说明服务正常，对外用 Cloudflare Tunnel（见 4.1）。

## 8. 已知坑 / 排错

| 现象 | 原因与处理 |
|---|---|
| 构建报 `Failed to load PostCSS config: Unexpected token 'export'` | 已修（见上表）。若你改回去了，恢复成 `postcss.config.cjs` |
| `better-sqlite3` 装不上：`Could not find any Visual Studio installation` / `node-gyp` 失败 | 用 Node 20 构建（Node 26 没有对应预编译包）；Linux 上装 `build-essential python3` 即可 |
| 登录接口一直转圈不返回 | stdout 管道断开导致（已修）。老版本可临时用 `WAAM_NO_CONSOLE=1` 规避，或让服务以文件重定向 stdio 启动 |
| 页面能开、操作一直转圈 | 反向代理没转发 WebSocket `Upgrade` 头 |
| 账号登录报 `Chrome 调试端点连接超时` | 没装 Chrome，或 root 下缺 `--no-sandbox`：确认 `google-chrome --version` 可用、`WAAM_CHROME_NO_SANDBOX=1` |
| 服务起来就退出 | `journalctl -u waam -n 50`；常见是 `DISPLAY` 缺失（服务里必须走 `xvfb-run`）或 9527 被占用 |
| `xvfb-run: 184: 0: not found` | 给 `xvfb-run` 传了 `-s/--server-args`，去掉即可（见 7.1 第 2 条） |
| 域名访问返回 `530` + `error code: 1033` | 边缘不知道这个隧道。两个常见原因：① 本地 `config.yml` 的 `tunnel:` 和 token 里的隧道冲突（删掉本地 config）；② 刚下发 ingress 配置，等 10–30 秒 |
| 建隧道 API 一直 403 | Account ID 不对。用 `GET /zones/<zone_id>` 里的 `result.account.id`，别凭 token 猜 |
| `was compiled against a different Node.js version` | better-sqlite3 的 ABI 不对，按 7.1 第 1 条重建 |
| 公网打不开但本机能 `curl` 通 | 服务商封了端口，走 Cloudflare Tunnel（见 4.1） |
| 想换管理员密码 | 管理后台改密码接口（改完所有 token 失效需重登）；或删库重来：停服务 → 删 `/var/lib/waam/database` → 设 `WAAM_ADMIN_PASSWORD` → 启动 |

> 注意：仓库根目录的 `WEB_MODE.md` 里写的 `--web` 参数在当前代码里已经没有了
> （`src/main/index.ts` 里管理端**始终**启动 Web 服务，不需要也不识别 `--web`）。
> 直接跑程序就是 Web 模式。
