# WhatsApp 账号管理器 — 项目规划与开发约束

> ⚠️ **全局强制约束**：任何代码修改前必须先完整阅读 `src/main/commands/index.ts`（全局命令中心），并同步检查 `src/main/ipc/account.ts:9` 的参数映射与 `src/main/web/server.ts:253` 的 WS 转发。未读全局命令不得动任何业务代码。

## 1. 项目全貌

| 端 | 入口 | 产物 | 域名/端口 |
|---|---|---|---|
| 管理中心桌面 `kuai-x` | `src/main/index.ts:30` / `src/renderer/App.tsx:14` | `kuai-x Setup 2.5.0.exe` (`electron-builder.central.yml:1`) | 本地窗口 + `kuai-x.exe --web` → `http://localhost:9527` → `https://guanli.whatspph.com`（隧道 `waam:b7978c7f-fcf6-42d1-a140-4b3f23a36fa6`） |
| 员工端 `kuai-z` | `src/main/employee.ts:1` / `src/renderer/EmployeeApp.tsx:1` | `kuai-z Setup 2.5.0.exe` (`electron-builder.employee.yml:1`) | 经 `wss://waam-relay.yix309672.workers.dev/ws`（Worker `RAMSG5LDRX5Z`）连管理中心 |
| 指纹工具 | `C:\Users\39712\Desktop\whatsapp-fingerprint-tool\` | `WhatsApp客户端助手 Setup 1.1.0.exe` | 算法 `SHA256(platform|arch|sha256(sorted_macs))` 64位，`src/main/services/fingerprint.ts:26` |
| 前端验证 H5 | `web-dist/`（`vite` 产）→ `waam-web.pages.dev` | `https://www.whatspph.com` + 裸域 `https://whatspph.com`（需 juyu.com 加 `@` 指向 `waam-web.pages.dev`） | 模板 `TemplatesPanel.tsx:14` classic/modern/dark，切视觉不改校验 |

**技术栈**：Electron 28.3.3, React 18, whatsapp-web.js 1.25.4, better-sqlite3 9.4, ws 8, zustand 4, Tailwind 3。Chrome 版本锁定见 `ChromeLauncher.ts:89`。

## 2. 架构与数据流

```
[H5 验证 whatspph.com] --(visit_logs)--> [kuai-x]
[kuai-x --web:9527] --(handleCommand)--> [better-sqlite3 accounts.db] + [ChromeLauncher --remote-debugging-port] + [WhatsAppSessionManager]
[kuai-x] --(RelayClient)--> [Cloudflare Worker relay] <--(EmployeeRelayClient)-- [kuai-z]
[WhatsAppSessionManager:emitAccountEvent:360] --(BrowserWindow + broadcastWebEvent + relayPushEvent)--> 前端事件 bus
```

- **DB** `src/main/utils/db.ts:31`：`accounts`（`assigned_to/remark/machine_fingerprint`）、`employees`（`machine_fingerprint`）、`login_logs/visit_logs/feedback/app_settings`，迁移含外键修复与去 UNIQUE。
- **会话** `WhatsAppSessionManager.ts:37`：健康检测 30s、指数退避重连 3s*2^n 最多5次、blank 页清理。
- **安全** `security.ts:361`：反调试 5s、asar 完整性、限流 5次/15min封30min、AES-256-GCM、审计日志、sanitizeSql/isValidUsername。

## 3. 全局命令（必读）

**唯一真源** `src/main/commands/index.ts:81 handleCommand(ctx, method, params)`，所有 IPC 与 WS 均经此：

- 账户：`account:list/create/get/has_session/update/delete/login/logout/request_pairing/request_pairing_with_phone/logs`（`account.ts:12` 映射）
- 员工管理：`employee:create/list/delete/assign/unassign/reset_fingerprint`
- 员工端隔离：`employee:login/list_mine/login_account/get_session/logout_account/pairing_code/my_status`（`requireEmployee:53` 校验 token）
- 浏览器：`browser:open/close/status`（可见/无头切换）
- 系统：`relay:get-config/set-server/regenerate-code/apply-config/status`、`store:*`、`fingerprint:get`、`app:version`、`system:auto_restore/info`、`stats:record/summary/events`、`template:get/set`、`security:audit_logs/status`
- **新增 Web 管理**：`server.ts:286 ctx={sessionManager, clientId:web_xxx, clientInfo:{ip,country,ua}}`，前端经 `webApi.ts:50 wsInvoke` 调用。

> **修改前必读清单**：`commands/index.ts` 全量 switch、`ipc/account.ts:9 buildCommandMethods` 参数打包、`webApi.ts:28 wsInvoke` 事件分发、`WhatsAppSessionManager.ts:358 emitAccountEvent` 三端广播。若改 method 名/参数，需三处同步。

## 4. Web 管理后台（本次重建）

- `src/main/web/server.ts:168 startWebServer`：静态 `dist/renderer`、`/api/login`（限流+SHA256 校验）、`/api/change-password`、`ws /ws?token` 鉴权、`broadcastWebEvent:147`。
- `src/renderer/webApi.ts:1`：`isBrowser/installWebApi/loginAdmin/logoutAdmin`，心跳 ping 30s，自动重连。
- `src/renderer/components/LoginGate.tsx:1`：管理员登录门禁，token 存 `localStorage waam_token`。
- `src/main/index.ts:27 isWebMode`（`--web`/`WAAM_MODE=web`），`WEB_MODE.md:1` 约定 `WAAM_WEB_PORT=9527`/`WAAM_ADMIN_PASSWORD`。

## 5. 重要规划（优先级）

**P0 — 稳定性**
- [ ] 移除未用 `@aws-sdk/client-s3:15`（`package.json:16`）
- [ ] 密码文件统一：`web-admin-password.txt` 当前与 `employees.password_hash+salt` 双轨，考虑统一走 `employeeAuth.ts`
- [ ] `cloudflared` 隧道常驻化（`config.yml:1` 已配 `guanli→9527`，需 juyu.com 加 `guanli CNAME b7978c7f...cfargotunnel.com` 与裸域 `@→waam-web.pages.dev`）

**P1 — 功能**
- [ ] 前端验证联动：`WhatsAppLoginModal.tsx:47 handleVerify` 由假 1.5s 改为真 `https://www.whatspph.com/?verify=` + `postMessage` 回传
- [ ] 员工 Web 化可选：`yuangong.whatspph.com` 复用 `startWebServer` 另一 ingress
- [ ] 配对码体验：`WhatsAppLoginModal.tsx:187` “打开 WhatsApp” 已加（`whatsapp://app`/`web.whatsapp.com`），需实机验证是否触发系统通知

**P2 — 观测**
- [ ] `StatsPanel.tsx:1` + `visit_logs` 已打点，需验证 `web/server.ts:289 clientInfo` 是否完整落库（含 country/ua 解析 `ua.ts:1`）
- [ ] `security:audit_logs` 暴露到 Web 管理页，便于审计

## 6. 开发约束（每次改码前执行）

1. `Read src/main/commands/index.ts` 全量，确认 method 是否已存在、ctx 权限（`requireEmployee`）与审计。
2. `Read src/main/ipc/account.ts` 确认新增命令是否需加入 `buildCommandMethods`。
3. `Read src/main/web/server.ts` 确认 WS 鉴权与 `broadcastWebEvent` 是否需扩展。
4. `Read src/preload/index.ts` 与 `src/renderer/webApi.ts` 确认前端 `window.api` 形态是否一致。
5. 改 DB 需同步 `src/main/utils/db.ts:31 runMigrations` 并考虑 `better-sqlite3` 在 Electron 28 ABI 119 下的 `npmRebuild:false`。
6. 改图标需走 `set-icon-central.js / set-icon-emp.js` 的 `rcedit` afterPack，勿改 `signAndEditExecutable:false`。
7. 提交前 `npm run build:central` 本地过一遍，安装包拷桌面验证（含 `LoginGate` 与配对按钮）。

## 7. 目录速查

- `src/main/index.ts:130` 管理中心启动、`src/main/employee.ts:1` 员工启动
- `src/main/services/ChromeLauncher.ts:64` / `WhatsAppSessionManager.ts:47`
- `src/main/utils/security.ts:127` 限流 / `db.ts:31` 迁移
- `src/renderer/components/WhatsAppLoginModal.tsx:78` 验证三步、`TemplatesPanel.tsx:35`
- `electron.vite.config.ts:5` 三端构建、`electron-builder.*.yml:1`
- `cloudflare-worker/` + `relay-server/` + `C:\Users\39712\.cloudflared\config.yml`

---
*生成于 2026-08-30，基于 `main@d182c49` + 本次 Web 重建（`webApi/LoginGate/isWebMode`）。下一次改码请从顶部约束开始。*
