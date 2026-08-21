# Web 模式部署说明

## 是什么

管理器除了桌面版，还支持 `--web` 模式：在服务器上运行，浏览器远程访问全部管理功能
（账号、员工、统计、反馈、模板等）。桌面版不受影响，两种模式可共存。

## 启动方式

```bash
# 方式一：环境变量
WAAM_WEB_PORT=9527 WAAM_ADMIN_PASSWORD=你的密码 WhatsApp Account Manager.exe --web

# 方式二：默认值（端口 9527，密码 **REMOVED**）
WhatsApp Account Manager.exe --web
```

- 端口：环境变量 `WAAM_WEB_PORT`，默认 `9527`
- 管理员密码：环境变量 `WAAM_ADMIN_PASSWORD`，默认 `**REMOVED**`
  - 首次启动后密码哈希保存在 `%APPDATA%\whatsapp-account-manager\web-admin-password.txt`，
    之后修改环境变量不会再改变已存密码（要改密码删除该文件后重启）
- 浏览器访问：`http://服务器IP:9527`，登录页输入管理员密码

## 安全建议（必须）

1. **不要用默认密码**。部署时务必设置 `WAAM_ADMIN_PASSWORD`
2. 服务器防火墙只放行 9527 端口
3. 建议套 HTTPS：
   - 方案 A：Nginx/Caddy 反向代理 + Let's Encrypt 证书
   - 方案 B：Cloudflare Tunnel（免费，映射到自有域名，自带 HTTPS）
4. 服务器需安装 Chrome（whatsapp-web.js 依赖），Windows 服务器需保持开机

## 浏览器支持

Chrome / Edge / Firefox 最新版均可。界面与桌面版一致。

## 部署测试（自检清单）

- [ ] `http://IP:9527` 打开显示登录页
- [ ] 错误密码被拒绝
- [ ] 正确密码进入管理器
- [ ] 账号列表 / 登录 / 退出 / 配对码 正常
- [ ] 员工管理正常
- [ ] 服务器重启后服务自动恢复（设置开机启动/服务化）