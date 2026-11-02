# KC GPT 自动充值系统

> **KC ChatGPT PLUS 訂閱開通平台**  
> 使用者貼上 Session 與兌換 CDK 後，可使用本地 Stripe 自動化流程，或啟用第三方代充 API 建立並輪詢代充訂單。  
> 配套管理後台：卡池管理、CDK 管理、任務監控、帳單稽核、第三方代充積分與套餐狀態、並發控制。

| 开发者 | TG | 
|--------|-----|
| **KC** | KcCatk |

[License: MIT](LICENSE) · Node.js 20+ · MySQL 8 · Playwright · Docker · [GitHub](https://github.com/KC-CatK/KC-PAY-GPT)

> ## 加入 Telegram 社群
> **[點此加入 AI科研組 Telegram 群組](https://t.me/+xPBORDjtky9mM2Mx)**

---

## 这是什么

`KC-GPT-PAY`（KC GPT 自动充值系统）是一套 **Node.js + Playwright + MySQL** 服务端方案，包含：

- **用户前台**（`/public/index.html`）：卡密兑换、Session 提交、订阅自动开通、状态查询
- **管理后台**（`/admin`）：卡池 / CDK / 任务 / 账单 / 系统配置 / 运行日志
- **本地自動化引擎**：Stripe Checkout 填表、信用卡輪換、hCaptcha 求解、反指紋瀏覽器與失敗重試
- **第三方代充 API**：支援套餐／積分查詢、Session 預檢、代充建單、訂單輪詢，以及失敗訂單的供應商卡密前綴顯示

啟用第三方代充 API 後，前台兌換會完全改走供應商代充流程，不再使用本地開通。

### 支持的订阅套餐

| 套餐 | 本地标识 `plan_type` | Checkout `plan_name` |
|------|---------------------|----------------------|
| Go | `go` | `chatgptgoplan` |
| Plus | `plus` | `chatgptplusplan` |
| Pro 10X | `pro_10x` | `chatgptprolite` |
| Pro 20X | `pro_20x` | `chatgptpro` |
| Pro 50X | `pro_50x` | `chatgptpromax` |

旧 Pro 5X 不再兼容；历史数据库记录不会自动修改。第三方代充必须在供应商套餐列表中提供与所选套餐 `plan_name` 匹配且已启用的项目，否则会报错而不会自动切换套餐。实际套餐可用性和价格以上游返回为准。

> ⚠️ **仅供学习与研究**。使用前请确保符合目标平台 ToS 与所在地法律法规。**开发者不对任何滥用导致的封号、扣款、法律纠纷负责。**

---

## 系统要求

| 组件 | 要求 |
|------|------|
| **Node.js** | ≥ 20.x |
| **MySQL** | ≥ 8.0 |
| **記憶體** | ≥ 2 GB（本地瀏覽器自動化建議 4 GB+） |
| **磁盘** | ≥ 5 GB（含 Chromium + Python hCaptcha 依赖） |
| **操作系统** | Linux / macOS / Windows |

Linux 无图形界面跑 headless 时，需安装 Playwright 系统依赖（见下方各平台说明）。

---

## 部署教程

### 方式一：Docker 一键部署（推荐）

适合 Linux 云服务器、macOS、Windows（Docker Desktop），**自带 MySQL 8**，无需单独装数据库。

#### 1. 安装 Docker

```bash
# Ubuntu / Debian（一键脚本）
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker && sudo systemctl start docker

# macOS / Windows — 安装 Docker Desktop
# https://www.docker.com/products/docker-desktop/
```

#### 2. 拉取代码并配置

```bash
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
test -e .env || cp .env.example .env
```

编辑 `.env`，至少填写：

```env
DB_PASSWORD=your_strong_mysql_password   # MySQL root 密码
ADMIN_PASSWORD=your_admin_password         # 后台登录密码
PROXY=http://user:pass@proxy-host:port     # 本地自動化或第三方訂單代理（選填）
BROWSER_POOL=0                              # 可选：关闭浏览器池；后台设置优先
```

#### 3. 一键启动

```bash
docker compose up -d
```

首次构建镜像需数分钟（含 Playwright Chromium + hCaptcha Python 依赖）。启动成功后：

| 地址 | 说明 |
|------|------|
| `http://服务器IP:28080/` | 用户前台（卡密兑换） |
| `http://服务器IP:28080/admin-login` | 后台登录（默认路径可在后台修改） |

示例 `.env` 设置宿主机端口为 28080；未设置 `PORT` 时 Compose 使用 3100。实际端口以 `docker compose ps` 为准。容器内服务始终使用 3000。若后台路径曾被修改，请使用后台配置的路径；`/admin-login.html` 不提供访问。

#### 4. Docker 常用命令

云服务器上更新并重建当前项目，可在项目根目录执行：

```bash
sudo bash ./deploy.sh
```

脚本会从 `origin/main` 获取最新代码、先构建新应用镜像，再替换本项目容器和旧应用镜像并等待健康检查。它保留 `.env`、MySQL 数据卷和运行数据，不清理其他项目；已有未提交改动会备份到 Git stash。完整条件及回滚说明见 [部署文档](DEPLOY.md#一键重新部署)。

```bash
# 查看应用日志
docker compose logs -f app

# 重启应用
docker compose restart app

# 停止并移除容器（数据卷保留，MySQL 数据不丢）
docker compose down

# 更新代码后重新构建
docker compose up -d --build

# 进入容器调试
docker compose exec app bash
```

> **注意**：请勿使用 `docker compose down -v`，否则会删除 MySQL 数据卷。配置写入 MySQL 后，重启容器不会丢失。

---

## 第三方代充 API

在後台「系統配置 → 第三方代充 API」填寫 API Key 後啟用。預設 Base URL 為：

```text
https://kc.vpss.eu.cc/
```

啟用後，系統會：

1. 使用供應商 `/plans` 取得 GPT 與積分套餐資訊。
2. 以 `/balance` 顯示可用積分與 USD 餘額。
3. 以 `/pay/inspect` 檢查 Session 格式與 JWT 有效期，再以 `/pay` 建立代充訂單。
4. 輪詢供應商訂單結果；後台僅顯示失敗代充訂單及上游公開的 `topup_code` 前綴，不會保存或展示完整卡密。

API Key 至少需要 `plans:read`、`balance:read`、`pay:write` Scope；如需使用任務查詢，另需 `tasks:read`。完整供應商協議見 [對接 API 文件](docs/对接api.md)。

> 浏览器池未配置时默认启用，可通过 `BROWSER_POOL=0` 关闭；已保存的后台设置优先。第三方代充模式不使用本地浏览器开通流程。

---

### 方式二：多端裸机部署

适合不想用 Docker、或需要在本地调试的场景。

#### macOS / Linux 一键安装

```bash
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
chmod +x scripts/install.sh
./scripts/install.sh
```

脚本会自动检测系统（macOS / Ubuntu / Debian / CentOS 等），安装 Node.js 20+、npm 依赖、Playwright Chromium 及 Linux 系统库。

#### Windows 一键安装

以**管理员权限**打开 PowerShell：

```powershell
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

#### 手动安装（各平台通用）

**① 安装 Node.js 20+**

```bash
# macOS (Homebrew)
brew install node@20

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Windows — 下载 LTS 安装包
# https://nodejs.org/
```

**② 安装 Playwright 系统依赖（仅 Linux 服务器）**

```bash
# Ubuntu / Debian 推荐
npx playwright install --with-deps chromium

# 或手动安装常见依赖
sudo apt-get install -y wget curl fonts-liberation fonts-noto-cjk \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libxss1 libasound2 libpangocairo-1.0-0 libxshmfence1
```

macOS / Windows 无需额外系统依赖。

**③ 安装项目依赖**

```bash
npm install --production
npx playwright install chromium
```

**④ 安装并初始化 MySQL 8**

```bash
# Ubuntu
sudo apt-get install -y mysql-server && sudo systemctl start mysql

# macOS
brew install mysql && brew services start mysql

# 创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

**⑤ 配置环境变量**

```bash
cp .env.example .env
# 编辑 .env
```

裸机部署关键项：

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=plus_papay
ADMIN_PASSWORD=你的后台密码
PROXY=http://user:pass@proxy-host:port
HEADFUL=0          # 调试时可设为 1 开启有头浏览器
```

**⑥ 启动服务**

```bash
npm start
# 或调试模式（有头浏览器）
npm run start:headful
```

启动成功示例：

```
🔓 [资产锁] 启动时已重置所有 in_use 标记
数据库表检查完成
http://localhost:3000
MySQL => root@127.0.0.1:3306/plus_papay
```

---

### 方式三：PM2 生产守护（裸机推荐）

```bash
npm install -g pm2
pm2 start server.js --name kc-gpt-pay
pm2 startup          # 配置开机自启
pm2 save
pm2 logs kc-gpt-pay  # 查看日志
pm2 restart kc-gpt-pay
```

---

### 方式四：Nginx 反向代理 + HTTPS

通过域名访问或启用 HTTPS 时，Docker 示例配置反代到宿主机 `127.0.0.1:28080`；裸机默认使用 3000，其他情况请按 `PORT` 调整：

```nginx
server {
    listen 80;
    server_name your-domain.com;

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

免费 HTTPS（Let's Encrypt）：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 首次使用

1. 打开后台 → **系统配置**：填写代理、支付地区（默认菲律宾 PHP）、邮箱通道、hCaptcha 等
2. **卡池管理** → 批量导入信用卡（格式：`卡号|有效期|CVC|持卡人姓名`）
3. **免税地址** → 确认当前地区有足够地址模板（默认已预置）
4. **CDK 管理** → 生成 Go / Plus / Pro 10X / Pro 20X / Pro 50X 激活码
5. 用户访问前台 → 输入 CDK → 粘贴 Session JSON → 提交，约 3–5 分钟自动开通
6. 在 **任务管理** / **运行日志** 查看进度与结果

### 用户卡密充值后的自动续费

- 用户前台通过 `/api/run-process` 发起的卡密充值，在确认充值成功后自动取消续费；本地自动化与第三方代充均适用。
- 取消后查询订阅状态，只有有效订阅的 `will_renew` 为 `false` 才显示“已确认关闭自动续费”。新订阅生效或状态更新延迟时会有限重试。
- 续费处理期间任务保持进行中；最终结果保存在任务消息中，前台、后台与通知均可查看。取消失败或未确认时仍保留充值成功与卡密已使用状态，提示联系管理员，不重复扣款或回滚卡密。
- 后台手动开通 `/api/admin/trigger-activation` 不自动取消续费，原有手动管理功能保留。本次调整不批量处理历史充值记录。

---

## 主要功能

| 模块 | 说明 |
|------|------|
| **CDK 兑换** | Go / Plus / Pro 10X / Pro 20X / Pro 50X 五档套餐，一卡一充 |
| **信用卡卡池** | 批量导入、智能选卡、冷却机制、Stripe 拒卡自动报废、失败换卡重试 |
| **支付地区** | PH / US / SG / MY / EG（埃及，EGP）可切换 |
| **账单审计** | 自动记录每笔支付，支持筛选与 CSV 导出 |
| **瀏覽器池** | 本地自动化的可选多槽位模式；未配置时默认启用，可设 `BROWSER_POOL=0` 关闭 |
| **hCaptcha** | VLM / 打码平台 / Python solver 多通道 |
| **反指纹** | Stealth + 30+ 指纹点修正，支持真 Chrome / Edge |
| **Telegram 通知** | 任务成功 / 失败推送（后台配置） |
| **并发 & 维护模式** | 前台并发上限、维护开关，保存即生效 |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     server.js (Express)                      │
│   /api/redeem/*   /api/cdk/*   /api/admin/*   /api/public/* │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────┐            ┌─────────────────────┐
│  子进程任务调度      │            │  public/admin.html  │
│  任务调度 / 重试     │            │  KC GPT 管理后台     │
└─────────────────────┘            └─────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  index.js / src/payments / src/browser / src/checkout        │
│  Stripe Checkout 自动化 · Session 鉴权 · 卡池支付 · 重试      │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  MySQL — 卡池 / CDK / 任务 / 账单 / 配置 / Session 记录       │
└─────────────────────────────────────────────────────────────┘
```

---

## 目录结构

```
.
├── server.js              # Web 入口和任务调度
├── index.js               # 任务子进程入口
├── src/
│   ├── admin/             # 后台认证及路径
│   ├── browser/           # 浏览器池、Session 和代理适配
│   ├── captcha/           # 验证码相关模块
│   ├── checkout/          # 套餐和结账流程
│   ├── config/            # 地区等配置
│   ├── integrations/      # 第三方 API、通知
│   ├── payments/          # 支付、卡片及地址模块
│   ├── persistence/       # MySQL 数据访问
│   ├── proxy/             # 代理池
│   ├── runtime/           # 运行日志
│   └── project-paths.js   # 项目根目录和运行数据路径
├── database/              # 数据库迁移 SQL
├── mysql-schema.sql       # 初始化 SQL；保留原路径以兼容既有 Docker 挂载
├── hcaptcha/              # Python hCaptcha solver
├── public/                # 用户前台和管理后台静态文件
├── scripts/               # 部署入口、安装及数据库维护脚本
│   └── db/                # 数据库迁移/重置脚本
├── docs/                  # 对接文档与历史记录
├── test/                  # 自动测试
├── data/                  # 持久化配置和浏览器池数据，不随源码迁移
├── docker-compose.yml     # Docker 一键部署
├── Dockerfile
└── .env.example
```

`debug_screenshots/` 和 `product_files/` 等运行数据仍位于项目根目录；重构不会迁移或清空它们。`scripts/db/reset-db.js` 会删除数据库表，不应在升级时运行。

---

## 接口文档

本系統 REST API 請依 `server.js` 路由使用；第三方代充接口見 [對接 API 文件](docs/对接api.md)。常用接口：

| 用途 | Method + Path | 鉴权 |
|------|---------------|------|
| 用户兑换开通 | `POST /api/redeem-product` | 无 |
| 查询 CDK 状态 | `GET /api/cdk/query?cdk=...` | 无 |
| 后台登录 | `POST /api/admin/login` | 密码 |
| 卡池批量导入 | `POST /api/admin/cards/import` | Bearer |
| 外部卡池推送 | `POST /api/external/cards/push` | X-API-Key |
| 账单 CSV 导出 | `GET /api/admin/billing/export` | Bearer |
| 实时运行日志 | `GET /api/admin/runtime-logs` | Bearer |

---

## 常见问题

**Q: Docker 里浏览器崩溃？**  
A: `docker-compose.yml` 已配置 `shm_size: 2gb`。仍崩溃可改为 `4gb`，并确保宿主机内存 ≥ 4 GB。

**Q: Linux 上 Chromium 启动失败？**  
A: 执行 `npx playwright install-deps chromium`，确认 `HEADFUL=0`（无头模式）。

**Q: MySQL 连接被拒绝？**  
A: Docker 模式下 `DB_HOST=mysql`（compose 服务名）；裸机模式下 `DB_HOST=127.0.0.1`。确认 MySQL 服务已启动。

**Q: Stripe 一直 `redirect_status=failed`？**  
A: 多为卡 BIN 被风控、余额不足或代理 IP 不干净。换卡、换代理、确认支付地区设置。

**Q: 卡池枯竭怎么办？**  
A: 后台批量导入，或配置 Webhook `POST /api/external/cards/push` 自动补货。

**Q: 修改哪些文件需要重启？**  
A: `server.js` 和由主进程加载的 `src/` 模块需重启；仅由任务子进程加载的模块在下次任务启动时读取。Docker 更新目录结构后应重建并重新创建 app 容器，参见 [部署说明](DEPLOY.md)。

**Q: Windows 上 Playwright 安装失败？**  
A: 管理员 PowerShell 执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，再 `npx playwright install chromium`。

---

## 端口说明

| 端口 | 用途 |
|------|------|
| 28080 | 示例 `.env` 中的 Docker 宿主机 Web 端口；未设置 `PORT` 时为 3100 |
| 3000 | 容器内 Web 端口；裸机服务默认端口 |
| 3310 / 3306 | Docker 宿主机 MySQL 端口 / 容器内 MySQL 端口 |
| 19222+ | 瀏覽器池 CDP 連接埠（僅啟用 `BROWSER_POOL=1` 時使用） |

---

## 开发者 & 联系方式

| 项目 | 信息 |
|------|------|
| 开发者 | **KC** |
| TG | **KcCatk** |




---

## 免责声明

本项目所有代码以 **「AS IS」** 形式发布，开发者**不对以下情形负责**：

- 因使用本项目导致的 OpenAI 账号封禁、银行卡风控
- 违反目标平台 ToS 或所在地法律法规所引起的任何后果
- 因使用本项目导致的资金损失、数据泄露、第三方权益受损

**使用即表示你已阅读、理解并接受以上条款。**

---

## 许可

[MIT License](LICENSE) © KC
