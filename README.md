# dsh-llm-chatgpt

为 DSH 内置的官方 `openai-codex` 路由提供设置页登录入口。

## 这个插件做什么

DSH 的 `@deepseek-ai/dsh-llm-pi-ai` 已内置官方实现：它直接引入 `@earendil-works/pi-ai`，其中包含 `openai-codex` provider——端点、协议、模型目录、OAuth 与凭据刷新全部由 pi-ai 提供。

但 pi-ai 的 provider 登录注册到 DSH 授权服务后，**宿主没有任何界面调用它**：模型设置页的 `settings.models.sign-in` 槽位属于 DeepSeek 账号，`settings.models.provider-card` 槽位没有注册者。结果是官方路由只能靠外部脚本登录。

本插件补上这个缺口，且**不实现任何协议**——它是一层界面：

- 在模型设置页的 `openai-codex` provider 卡片上渲染登录按钮；
- 点击后驱动 pi-ai 自己的 OAuth 流程；
- 显示账户（名称、plan、凭据到期时间）；
- 提供退出并撤销会话。

凭据由 pi-ai 自己的 store 通过 DSH 的 `credentials.modifyRecord` 写入，因此运行中的适配器能观测到提交，无需重启。

## 安装

本机 `web` profile 可在普通终端执行安装脚本：

```sh
node ./scripts/install-local.mjs
```

脚本调用 `dsh plugin` 安装当前包，已安装同版本时跳过；先备份 profile 配置，再移除早期版本遗留的 `llm-chatgpt` 配置项（0.3.0 起本插件不再声明 provider 路由，残留项会指向无人服务的路由），最后检查组合配置与插件模块导入。它不启动 Web 服务、不调用模型、不进行登录。

也可以手动安装：

```sh
npm pack --cache .npm-cache
dsh plugin --profile web add ./dsh-llm-chatgpt-0.3.2.tgz
```

本插件不需要在 `cordis.patch.yml` 中添加任何配置项。

## 使用

1. 重启 `dsh --profile web`；
2. 打开「设置 → 模型」；
3. 找到 `openai-codex` 那一行，点击卡片上的**登录 ChatGPT**；
4. 浏览器打开授权页，登录并允许；卡片会自动更新为已连接。

若 `openai-codex` 不在 provider 列表中，用模型页的「添加 → 从目录添加」（`addCatalog`）声明它——pi-ai 适配器只注册 profile 中已声明的路由，未声明的 provider 即使已登录也无法选择。该路由不需要 `apiKeyEnv`，留空才能让存储的 OAuth 凭据完成鉴权。

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

`scripts/login-openai-codex.mjs` 和 `scripts/add-openai-codex-route.mjs` 是为没有设置页入口的旧版环境保留的手工排障工具，当前安装流程不会调用。正常使用优先通过模型设置页登录并用「从目录添加」声明路由。

## 首版限制

- 只负责登录界面，不改变模型行为；图片输入、WebSocket 传输、推理等级等由官方实现决定。
- 不提供模型列表编辑，也不自动修改默认模型。
- 账户信息来自凭据中的 JWT 声明（名称、plan、到期时间），不请求额外接口。

## 验证范围

`npm test` 使用 Node 内建测试运行器。`tests/codex.test.js` 覆盖 flow 缺失、登录通知、提交后状态、取消与退出、令牌不泄漏与 capability 校验；`tests/client.test.js` 用模拟模块加载器渲染真实 factory，覆盖卡片只在 `openai-codex` 行渲染、样式表生命周期、已连接 / 未连接 / 无 flow / 接口失败四种状态，以及授权 URL 延迟到达、状态轮询、popup 回退与取消入口。

`tests/installed-codex.test.js` 通过 `DSH_INSTALL_ROOT` 指定安装目录，用真实 `AuthorizationService` 与 `webServer` 验证端点注册与 index 注入：

```sh
DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test
```

**未验证**：真实浏览器点击完成一次 OAuth 授权。上述测试证明了端点注册、flow 发现、凭据读写路径与宿主服务接受度，但浏览器里点下去那一下仍需人工确认。

## 与 0.2.x 的区别

0.2.x 是本插件的早期形态：一个自带协议实现的独立 `chatgpt-plan` provider，包含 OAuth、Responses 协议、SSE 转换与模型目录，约 640 行，另加一个订阅管理页。

0.3.0 删除了全部协议实现，改为官方 `openai-codex` 路由的界面扩展。旧订阅页与 `chatgpt-plan` 路由一并移除；该路由的历史会话无法继续发送消息，但历史内容保留。

早期版本的改动记录见 [设计文档](docs/design-task-add-chatgpt-subscription-plugin.md)，方案 A 的实施与验证见 [登录入口设计文档](docs/design-task-openai-codex-in-plugin-login.md)。
