# dsh-llm-chatgpt

为 DSH 内置的官方 `openai-codex` 路由提供设置页登录入口。

## 这个插件做什么

DSH 的 `@deepseek-ai/dsh-llm-pi-ai` 已内置官方实现：它直接引入 `@earendil-works/pi-ai`，其中包含 `openai-codex` provider——端点、协议、模型目录、OAuth 与凭据刷新全部由 pi-ai 提供。

但 pi-ai 的 provider 登录注册到 DSH 授权服务后，**宿主没有任何界面调用它**：模型设置页的 `settings.models.sign-in` 槽位属于 DeepSeek 账号，`settings.models.provider-card` 槽位没有注册者。结果是官方路由只能靠外部脚本登录。

本插件补上这个缺口，且**不实现任何协议**——它是一层界面：

- 在模型设置页的 `openai-codex` provider 卡片上渲染登录按钮；
- 点击后驱动 pi-ai 自己的 OAuth 流程；
- 显示账户（名称、plan、凭据到期时间）；
- 提供退出登录并删除本地凭据（不撤销远端会话）。

凭据由 pi-ai 自己的 store 通过 DSH 的 `credentials.modifyRecord` 写入，因此运行中的适配器能观测到提交，无需重启。

## 开发与构建

源码、辅助脚本和测试均使用 TypeScript；`npm run check` 严格检查插件及脚本，`npm run build` 使用 tsdown 构建服务端 ESM 和客户端 IIFE。客户端产物保留 DSH 的 `__ModuleLoader__.load` factory 协议，`lib/` 中的 JavaScript 与类型声明由构建生成，不手写或提交。`npm pack` 会先运行类型检查与构建。辅助脚本在 Node 22.19+ 下以 `--experimental-strip-types` 运行。

## 安装

本机 `web` profile 可在普通终端执行安装脚本：

```sh
node --experimental-strip-types ./scripts/install-local.ts
```

脚本调用 `dsh plugin` 安装当前包，已安装同版本时跳过；先备份 profile 配置，再移除早期版本遗留的 `llm-chatgpt` 配置项（0.3.0 起本插件不再声明 provider 路由，残留项会指向无人服务的路由），最后检查组合配置与插件模块导入。它不启动 Web 服务、不调用模型、不进行登录。

也可以手动安装：

```sh
npm install
npm pack --cache .npm-cache
dsh plugin --profile web add ./dsh-llm-chatgpt-0.3.7.tgz
```

本插件不需要在 `cordis.patch.yml` 中添加任何配置项。

## 使用

1. 重启 `dsh --profile web`；
2. 打开「设置 → 模型」；
3. 找到 `openai-codex` 那一行，点击卡片上的**登录 ChatGPT**；
4. 浏览器打开授权页，登录并允许；卡片会自动更新为已连接。

若 `openai-codex` 不在 provider 列表中，用模型页的「添加 → 从目录添加」（`addCatalog`）声明它——pi-ai 适配器只注册 profile 中已声明的路由，未声明的 provider 即使已登录也无法选择。该路由不需要 `apiKeyEnv`，留空才能让存储的 OAuth 凭据完成鉴权。

### 缺失模型补丁（预览后确认）

已登录且宿主提供可写设置时，卡片上的「检查缺失模型」会以当前 OAuth 账号只读查询 Codex 模型目录，将可见、能力信息足够的条目与现有可选模型比较。预览无写入；仅在点击「确认补充缺失模型」后通过宿主设置服务写入。响应不向页面传输 OAuth 令牌；网络或模型来源不可用时**不使用旧 pi-ai catalog 猜测新增模型**，原配置保持不变。

补丁通过 `llm-pi-ai.providers.openai-codex.models` 保存；该字段会整体替换目录，插件在写入时保留已有模型及其显式配置。写入后若要撤回，请先在宿主模型设置中检查并编辑显式模型列表；当前版本不提供自动回退。补丁只能修复模型无法选中，不能修复账户无权限或旧版 pi-ai 缺少推理协议能力。当前目录请求使用经本机检查的 Codex CLI `0.160.1` 作为 `client_version`；后续版本需要复核并更新该值。只读的已登录 Codex 账号目录已确认包含 `gpt-6.1-sol`；该模型的 `ultra` 推理等级无法由当前 pi-ai 表示，补丁只暴露其已知等级并在预览中说明。通过 DSH 路由的端到端请求仍须验证。

## 网络

登录与推理都访问 `auth.openai.com` 与 `chatgpt.com`。若需要代理，导出标准环境变量即可，DSH 的进程级代理策略会让所有基于 `fetch` 的出站走代理：

```sh
# ~/.dsh/.env
https_proxy=http://127.0.0.1:7890
http_proxy=http://127.0.0.1:7890
no_proxy=localhost,127.0.0.1,::1
```

loopback 流量始终绕过代理，因此本机 Web UI 与 OAuth 回调不受影响。

## 辅助脚本

`scripts/login-openai-codex.ts` 和 `scripts/add-openai-codex-route.ts` 是为没有设置页入口的旧版环境保留的手工排障工具，当前安装流程不会调用。正常使用优先通过模型设置页登录并用「从目录添加」声明路由。

## 首版限制

- 不实现模型推理协议；图片输入、WebSocket 传输等仍由官方 pi-ai 实现。
- 只在预览并确认后补充缺失模型，不提供通用模型编辑，也不自动修改默认模型。
- 账户信息来自凭据中的 JWT 声明（名称、plan、到期时间），不请求额外接口。

## 验证范围

`npm run check` 对插件与辅助脚本做严格类型检查；`npm test` 先用 tsdown 构建，再使用 Node 内建测试运行器。`tests/codex.test.ts` 覆盖 flow 缺失、登录通知、提交后状态、取消与退出、令牌不泄漏与 capability 校验；`tests/client.test.ts` 用模拟模块加载器渲染真实 factory，覆盖卡片只在 `openai-codex` 行渲染、样式表生命周期、已连接 / 未连接 / 无 flow / 接口失败四种状态，以及授权 URL 延迟到达、状态轮询、popup 回退与取消入口。

`tests/installed-codex.test.ts` 通过 `DSH_INSTALL_ROOT` 指定安装目录，用真实 `AuthorizationService` 与 `webServer` 验证端点注册与 index 注入：

```sh
DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test
```

**未验证**：真实浏览器点击完成一次 OAuth 授权。上述测试证明了端点注册、flow 发现、凭据读写路径与宿主服务接受度，但浏览器里点下去那一下仍需人工确认。

## 与 0.2.x 的区别

0.2.x 是本插件的早期形态：一个自带协议实现的独立 `chatgpt-plan` provider，包含 OAuth、Responses 协议、SSE 转换与模型目录，约 640 行，另加一个订阅管理页。

0.3.0 删除了全部协议实现，改为官方 `openai-codex` 路由的界面扩展。旧订阅页与 `chatgpt-plan` 路由一并移除；该路由的历史会话无法继续发送消息，但历史内容保留。

早期版本的改动记录见 [设计文档](docs/design-task-add-chatgpt-subscription-plugin.md)，方案 A 的实施与验证见 [登录入口设计文档](docs/design-task-openai-codex-in-plugin-login.md)。
