# Checkout 调试：页面 SDK 请求与有头 UI 回退

日期：2026-11-01

## 现象与已确认原因

用户报告：

```text
API 创建 Checkout 失败: Our systems have detected unusual activity. Please try again later.
```

源代码中确认了两个独立问题：

1. 当前调试链路使用 `context.request.post`，没有接入页面的 Sentinel SDK。
2. `index.js` 的 `debugOnly` 异常分支立即抛错，导致已有 UI 备用流程永远无法执行；`server.js` 又强制设置 `CHECKOUT_MODE=api`。

这证明了请求上下文和回退链路的缺失，**不证明**上游拒绝仅由 Sentinel 引起。
本次没有使用实际账号 Session，也没有创建真实 Checkout 或提交付款。

## 实现

```mermaid
flowchart TD
    A[后台支付链接调试] --> B[注入 Session 并打开 ChatGPT]
    B --> C{CHECKOUT_MODE}
    C -->|api / auto| D[当前页面 SDK 初始化并获取新 token]
    D --> E[页面 fetch 创建 Checkout]
    E -->|成功且有链接| K[输出 CHECKOUT_URL 和成功标记]
    D -->|失败或超时| F{auto 模式?}
    E -->|失败| F
    F -->|否| X[记录错误并清理资源]
    F -->|是| G{UI_HEADFUL=1?}
    C -->|ui| G
    G -->|是| H[保存状态并启动独立有头浏览器]
    G -->|否| I[沿用当前浏览器]
    H --> J[UI 定价页选择地区和套餐]
    I --> J
    J --> L[发请求前核对 plan_name / country / currency]
    L -->|不匹配或 UI 失败| X
    L -->|一致且返回 Checkout| K
    K --> M[关闭任务 context / 自有浏览器]
    M --> N[调试任务结束，不进入填卡/付款]
```

### 请求

- `src/checkout/checkout-browser-request.js`：复用 `https://chatgpt.com` 当前页面；需要时加载站点 SDK。
- 使用 `init('chatgpt_checkout')` 和 `token('chatgpt_checkout')`。初始化后重新读取 `window.SentinelSDK`，避免调用被替换的 loader stub。
- 将 token 放入 `openai-sentinel-token`，通过页面 `fetch` 和 `credentials: include` 发送请求。
- device/account ID 仅取当前 Cookie 或会话，不生成随机值。
- SDK 和 API 都有超时；空 token、脚本加载失败、HTTP 错误或缺少链接不会记为成功。
- 原无页面 axios 辅助函数仍是兼容接口；后台调试实际走页面请求，并非该辅助函数。

### 回退与清理

- `CHECKOUT_MODE=auto` 默认 API 优先、失败后回退一次 UI。
- `CHECKOUT_MODE=api` 为明确的 API-only；`ui` 为 UI-only。
- 默认 `CHECKOUT_UI_HEADFUL=1`，独立启动有头 Chromium，不把已有的无头池当成有头浏览器。
- 保存 Cookie/localStorage，重新安装 Session 路由并恢复本次更新后的 Cookie；代理、区域、录像设置保留。
- 有头实例分配独立 CDP 端口，避免碰撞池端口。
- 初始浏览器/Session 安装失败也进入资源清理；关闭录像时仍关闭任务 context。
- UI 创建前核对实际请求的套餐与地区，避免两个 Pro 档位共用按钮造成静默换档。

### 部署

详见 `DEPLOY.md` 的 Checkout FAQ。Docker 镜像新增 Xvfb/xauth 和入口脚本，必须重建 app 镜像；Xvfb 不提供远程桌面。

## 验证记录

### 自动测试

```bash
npm test
```

结果：6 个测试文件，43 项通过。

- 修改前，实际 worker 的回归测试复现了 API 错误后 UI 调用次数为 0，以及 UI-only 调试直接失败。
- 修改后覆盖 API 成功、auto 回退、有头池绕过、API-only、UI-only、SDK 加载/超时/空 token、loader 对象替换、失败不误报成功、资源清理和套餐地区校验。
- worker 测试执行真实 `index.js` 控制流，浏览器/数据库/付款依赖被隔离；并断言调试中不会调用付款函数。

### 真实浏览器与容器

- Playwright 真实 Chromium：拦截测试页、SDK 和 Checkout 请求，验证相同会话 Cookie/device、SDK header，以及请求次数。未发送真实上游 Checkout。
- 真实独立有头 Chromium：验证跳过 pool、CDP Browser 信息不是 Headless、浏览器正常关闭。
- 真实 Chromium 路由：错误 Pro 档位在网络前中止，匹配档位继续到会话 context 路由。
- Debian Node 容器：验证入口脚本创建活跃 Xvfb socket、`XVFB_ENABLED=0` 跳过、已有 DISPLAY 保留；临时容器已清理。
- `node --check`、`sh -n`、`docker compose config --quiet`、`git diff --check` 通过。
- `package-lock.json` 未改变。

### 公开接口证据

2026-11-01 获取的站点 SDK loader 返回 HTTP 200，并声明 `SentinelSDK.init` / `SentinelSDK.token`：

- https://chatgpt.com/backend-api/sentinel/sdk.js
- 当日 loader 指向：https://chatgpt.com/sentinel/20260810913b/sdk.js
- `chatgpt_checkout` flow 和 header 的社区用例：https://linux.do/t/topic/3103524

生产代码使用 loader，不硬编码带日期的实现地址。公开用例不是稳定 API 契约。

## 尚未验证

- 用户实际 Session、账号、代理环境下是否不再出现 `unusual activity`。
- 当日真实定价页 DOM 是否匹配现有 UI 选择器，尤其是 Pro 档位和自定义 `plan_name`。
- 完整生产镜像重建（含原项目的 Python/ML 依赖）和部署后的端到端运行；本次只验证了 Xvfb 入口行为与配置格式。

线上最终判定：后台调试任务返回真实 `CHECKOUT_URL` 和 `CHECKOUT_DEBUG_SUCCESS`，且该链接与请求的套餐/地区一致。不能把单纯 HTTP 200 或本地 fixture 通过当作线上完成。

## 补充更正：创建会话与后续确认不是同一步

2026-11-01 再次核对用户提供的两份 HAR，均未包含 `POST /backend-api/payments/checkout` 创建请求；其中一份仅有对已有 Checkout 会话的读取。因此，这些抓包不能证明创建请求缺少某个特定的 Sentinel 头，也不能确定 `unusual activity` 的根因。

- 移除了此前根据后续阶段猜测加入的额外 SDK 调用和硬编码客户端来源头；保留此前的 `chatgpt_checkout` 页面 SDK 路径，但未将它视为已在真实账号验证的解决方案。
- 修复 UI 回退时，创建失败响应在点击返回之后才到达而导致错误详情丢失的竞态；响应体读取最多等待 1.5 秒，只展示已识别的异常活动提示和 HTTP 状态，不输出任意响应正文。
- HTTP 确认接口返回成功不等于已确认整个订阅完成。固定冷却时间、重试是否累计风险等也无法从现有 HAR 确认。

要进一步定位创建失败，需要从点击升级之前开始记录精确的创建请求，提供脱敏后的请求字段、响应状态和错误信息；不要包含 Cookie、令牌、卡片资料或其他支付凭据。

## 2026-11-02：浏览器创建请求实测

- 在已登录的 ChatGPT 免费套餐页面，通过官方升级界面观察到 `POST /backend-api/payments/checkout` 返回 HTTP 200，响应包含 `checkout_session_id` 和 `processor_entity`，`url` 为空。只记录字段名称、无敏感值的套餐/地区和状态；没有触发付款。
- 本次浏览器请求为 Plus、JP/JPY、`custom`。项目地区可配置，JP/JPY 不应被强制写为默认值。此成功样本无法说明另一次 `unusual activity` 的确切原因。
- 与项目原来的四字段载荷相比，浏览器创建载荷还包含 `cancel_url`、`checkout_appearance`、`checkout_source`、`purchase_attempt_id` 和 `supports_saved_payment_link`。由于这次没有保存它们的值，也没有失败请求作对照，不据此猜测字段内容或宣称它们是必需字段。
- 浏览器创建请求中同时出现 `oai-device-id` 和 `oai-did` 头；项目创建请求现在在页面存在有效 `oai-did` Cookie 时，将该 Cookie 的值作为 `oai-did` 请求头一并发送。此调整是协议差异对齐，并非已验证的风控修复。
- 当上游不返回链接时，代码现在根据响应中的 `processor_entity` 生成站内 Checkout 链接，并校验路径片段；响应未提供该字段时保留原有 `openai_llc` 默认值。响应没有有效链接时也不再把完整响应正文拼进错误日志。这些均是成功响应解析问题，与上游 400/403 风控是不同阶段。

本轮没有在原结账页调用最终确认，也没有针对项目的真实账号/部署环境执行 API 创建请求；仍需实际项目失败日志与同账号、同配置的成功/失败请求对照，才能判断 `unusual activity` 是否已经解决。

## 2026-11-02：用户 HAR 对照与账号头修正

- `/Users/yukaijun/Downloads/chatgpt.har` 中有一次创建请求：HTTP 200，返回了会话 ID；没有复现 `unusual activity`。请求为 Plus、JP/JPY、custom，不代表项目部署一定使用相同地区或网络。
- 成功请求中，`oai-did` 与 `oai-device-id` 相等，也与设备 Cookie 和 Sentinel 的 `id` 一致；`chatgpt-account-id` 与该请求的访问令牌中的账号标识一致。只比较相等关系，不记录任何实际标识、令牌或 Cookie。
- 发现代码在页面 bootstrap 存在但不含账号 ID 时，会忽略已注入 Session 中的账号 ID；如果 Session 也没有账号字段，则不会采用当前令牌里的账号标识。现按页面 bootstrap、已注入 Session、令牌 claim 的顺序选择有效账号 ID，无可用值时不发送。令牌解析只是提取请求上下文，不是本地签名验证或身份授权。
- 新增脱敏诊断行 `[Checkout] 请求上下文`，仅记录账号标识来源、标识与令牌是否一致、设备头/设备 Cookie 是否存在、Sentinel flow/设备是否匹配；不会输出实际标识或令牌。
- 该成功样本还出现 `checkout_appearance=light`、`checkout_source=chatgpt_web_merged` 和其他可选字段。由于没有对应失败请求，不能证明它们为风控拦截原因，也没有据此强行改写套餐、地区或支付相关配置。

本地测试能复现并覆盖账号头缺失和脱敏诊断，但无法重现上游风控。部署到实际环境后，应查看最终状态以及脱敏的 `[Checkout] 请求上下文`；出现 API 失败日志并不必然代表自动 UI 回退也失败。
