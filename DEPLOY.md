# 部署指南

## 系统要求

| 组件 | 最低要求 |
|------|----------|
| Node.js | >= 20 |
| MySQL | >= 8.0 |
| 内存 | >= 2GB（浏览器自动化需要） |
| 磁盘 | >= 5GB（含 Chromium 浏览器） |

---

## 方式一：Docker 部署（推荐）

最简单的部署方式，适合所有支持 Docker 的平台。

### 1. 安装 Docker

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker && sudo systemctl start docker

# macOS — 安装 Docker Desktop
# https://www.docker.com/products/docker-desktop/

# Windows — 安装 Docker Desktop (WSL2 模式)
# https://www.docker.com/products/docker-desktop/
```

### 2. 配置环境变量

```bash
test -e .env || cp .env.example .env
nano .env   # 填写 DB_PASSWORD 和 PROXY
```

关键配置项：
```env
DB_PASSWORD=your_strong_password   # MySQL 密码
PROXY=http://user:pass@proxy:port  # 住宅代理（强烈建议）
ADMIN_PASSWORD=your_admin_pass     # 后台管理密码
```

### 3. 一键启动

```bash
docker compose up -d
```

示例 `.env` 的访问地址：`http://your-server-ip:28080/admin-login`。
如果没有设置 `PORT`，Compose 默认使用宿主机 3100；容器内始终使用 3000，具体映射以 `docker compose ps` 为准。后台入口可以在后台修改，`/admin-login.html` 不提供访问。

### 4. 常用命令

```bash
# 查看日志
docker compose logs -f app

# 重启服务
docker compose restart app

# 停止所有
docker compose down

# 更新代码后重新构建
docker compose up -d --build

# 进入容器调试
docker compose exec app bash
```

---

## 方式二：裸机部署

适合 macOS / Ubuntu / Debian / CentOS / Windows。

### macOS / Linux 一键安装

```bash
git clone <your-repo-url> KC-GPT-PAY
cd KC-GPT-PAY
chmod +x scripts/install.sh
./scripts/install.sh
```

### Windows (PowerShell 管理员)

```powershell
git clone <your-repo-url> KC-GPT-PAY
cd KC-GPT-PAY
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

### 手动安装步骤

#### 1. 安装 Node.js 20+

```bash
# macOS (Homebrew)
brew install node@20

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Windows — 下载安装包
# https://nodejs.org/en/download
```

#### 2. 安装系统依赖（Linux）

Ubuntu/Debian:
```bash
sudo apt-get install -y \
    wget curl fonts-liberation fonts-noto-cjk \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libxss1 libasound2 libpangocairo-1.0-0 libxshmfence1
```

CentOS/RHEL:
```bash
sudo yum install -y \
    wget curl liberation-fonts google-noto-cjk-fonts \
    atk cups-libs dbus-libs libdrm mesa-libgbm gtk3 nspr nss \
    libXcomposite libXdamage libXrandr libXScrnSaver alsa-lib pango
```

macOS / Windows 不需要额外系统依赖。

#### 3. 安装项目依赖

```bash
npm install --production
npx playwright install chromium
```

#### 4. 安装 MySQL 8

```bash
# Ubuntu
sudo apt-get install -y mysql-server
sudo systemctl start mysql

# macOS
brew install mysql && brew services start mysql

# CentOS
sudo yum install -y mysql-server
sudo systemctl start mysqld

# Windows — 下载安装包
# https://dev.mysql.com/downloads/installer/
```

创建数据库：
```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

#### 5. 配置并启动

```bash
cp .env.example .env
# 编辑 .env，填写 DB_PASSWORD、PROXY 等

npm start
```

---

## 方式三：使用 PM2 守护进程（生产推荐）

```bash
# 安装 PM2
npm install -g pm2

# 启动
pm2 start server.js --name kc-gpt-pay

# 开机自启
pm2 startup
pm2 save

# 查看日志
pm2 logs kc-gpt-pay

# 重启
pm2 restart kc-gpt-pay
```

---

## 反向代理（Nginx）

如果需要通过域名访问或使用 HTTPS，以下示例使用 Docker 的示例宿主机端口 28080；裸机默认使用 3000，其他情况按 `PORT` 调整：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # WebSocket 支持
    location / {
        proxy_pass http://127.0.0.1:28080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

配合 Let's Encrypt 免费 HTTPS：
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 常见问题

### Q: 容器运行中但页面打不开或 app 显示 unhealthy？

先确认宿主机映射、应用进程与健康检查结果：

```bash
docker compose ps -a
docker compose logs --tail=100 app mysql
docker inspect --format '{{json .State.Health}}' kc-gpt-pay2-app
docker compose exec -T app ps -eo pid,ppid,stat,etime,args
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:28080/
```

如果修改过 `PORT`，把上面的 28080 换成实际宿主机端口。容器内健康检查连接 `localhost:3000`；若显示连接失败，应先排查 Node 是否启动以及 app 日志，而不是只修改云防火墙。Xvfb 启动失败时新版入口会记录原因并继续启动 Web，但有头浏览器需要可用的 `DISPLAY`。

### Q: Checkout 提示 unusual activity / UI 备用流程如何启用？

默认链路为 `页面 Sentinel SDK → 同会话 API → 失败时独立有头 UI → 输出链接`。
后台“支付链接调试”也使用此链路，拿到链接即停止，不填写银行卡、不提交付款。

```env
CHECKOUT_MODE=auto
CHECKOUT_UI_HEADFUL=1
CHECKOUT_SENTINEL_TIMEOUT_MS=15000
CHECKOUT_API_TIMEOUT_MS=30000
```

- `auto`：API 失败或 SDK 加载/取 token 超时后，回退一次 UI 定价页。
- `api`：只调用 API，失败直接返回错误，用于单独定位问题。
- `ui`：直接走 UI 定价页。
- `CHECKOUT_UI_HEADFUL=1`：UI 阶段不复用无头浏览器池；保存 Cookie/localStorage，保留 Session 和代理，另起有头 Chromium。
- `CHECKOUT_UI_HEADFUL=0`：UI 阶段沿用当前浏览器，适合不需要有头的部署。

UI 发出创建请求前会核对实际 `plan_name`、country 和 currency。
若页面当前选择了另一个 Pro 档位或忽略自定义套餐，会明确返回不匹配错误，不会静默创建不同套餐的链接。

SDK token 由当前页面实时获取，不从配置中硬编码或缓存。
`unusual activity` 可能同时涉及 Session、账号或网络状态；补充 SDK 请求上下文不保证上游一定接受。
查看任务日志，分别确认 `[Checkout] 使用当前页面 Sentinel SDK`、`正在回退到 UI`、`CHECKOUT_DEBUG_SUCCESS`；只有最后一个标记才表示本次调试返回了链接。

Docker 新镜像已包含 Xvfb，默认 `XVFB_ENABLED=1` 自动提供虚拟显示。增加依赖后须**重建镜像**，仅重启旧容器无效：

```bash
docker compose up -d --build app
docker compose logs -f app
```

Xvfb 是虚拟显示，不是 VNC/远程桌面；需要人工操作浏览器时使用本机桌面或自行连接图形会话。

### Q: Chromium 启动失败 (Linux 无图形界面)

安装所有系统依赖：
```bash
npx playwright install-deps chromium
```

裸机 Linux 使用有头 UI 时还需要 DISPLAY。无桌面服务器可执行：

```bash
sudo apt-get install -y xvfb xauth
xvfb-run -a -s '-screen 0 1920x1080x24 -nolisten tcp' node server.js
```

macOS/Windows 桌面无需 Xvfb。若只需现有无头 UI，可设 `CHECKOUT_UI_HEADFUL=0`。

### Q: Docker 中浏览器崩溃

增加共享内存：docker-compose.yml 中已配置 `shm_size: '2gb'`。如果仍然崩溃，可以增大到 4gb。

### Q: Windows 上 Playwright 安装失败

以管理员权限运行 PowerShell：
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
npx playwright install chromium
```

### Q: MySQL 连接被拒绝

检查：
1. MySQL 服务是否运行：`sudo systemctl status mysql`
2. 用户权限：`GRANT ALL ON plus_papay.* TO 'root'@'%';`
3. Docker 模式下 DB_HOST 应为 `mysql`（service name），裸机模式下为 `127.0.0.1`

### Q: 代理如何配置

在 `.env` 中设置：
```env
PROXY=http://username:password@proxy-host:port
```

支持 HTTP/HTTPS/SOCKS5 代理。强烈建议使用住宅代理以降低风控风险。

---

## 端口说明

| 端口 | 用途 |
|------|------|
| 28080 | 示例 `.env` 的 Docker 宿主机 Web 端口；未设置 `PORT` 时为 3100 |
| 3000 | 容器内 Web 端口；裸机服务默认端口 |
| 3310 / 3306 | Docker 宿主机 MySQL 端口 / 容器内 MySQL 端口 |
