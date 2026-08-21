# WAAM 中转服务器 (relay-server)

网页与本机账号管理器之间的 WebSocket 中转服务。部署到公网服务器（Linux VPS 等）。

## 部署步骤

1. 将本目录上传到服务器（只需 `server.js`、`package.json`、`package-lock.json`）
2. 安装依赖：

```bash
npm install --omit=dev
```

3. 启动（监听 0.0.0.0:8890，WebSocket 路径为 `/ws`）：

```bash
npm start
# 或自定义端口
PORT=8890 npm start
```

4. 建议用 Nginx + Let's Encrypt 反代启用 HTTPS（浏览器网页需要 wss://）：

```nginx
server {
    listen 443 ssl;
    server_name your.domain.com;
    # ... ssl cert ...
    location /ws {
        proxy_pass http://127.0.0.1:8890;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

网页端连接地址：`wss://your.domain.com/ws`（本地测试可用 `ws://localhost:8890/ws`）

## 机制

- 管理器启动后携带**接入码**注册；网页输入同一接入码绑定。
- 接入码即凭证：知道接入码的人可控制该管理器的所有账号，请妥善保管。
- 一个接入码同时只对应一台管理器，网页客户端可多个。
