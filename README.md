# dsh-llm-chatgpt

为 DSH 内置的官方 `openai-codex` 路由提供设置页登录入口。

## 这个插件做什么

DSH 的 `@deepseek-ai/dsh-llm-pi-ai` 已内置官方实现：它直接引入 `@earendil-works/pi-ai`，其中包含 `openai-codex` provider——端点、协议、模型目录、OAuth 与凭据刷新全部由 pi-ai 提供。

但 pi-ai 的 provider 登录注册到 DSH 授权服务后，**宿主没有任何界面调用它**：模型设置页的 `settings.models.sign-in` 槽位属于 DeepSeek 账号，`settings.models.provider-card` 槽位没有注册者。结果是官方路由只能靠外部脚本登录。

本插件提供设置页登录与额度展示，**不另实现 OAuth 或推理协议**：

- 在模型设置页的 `openai-codex` provider 卡片上渲染登录按钮；
- 点击后驱动 pi-ai 自己的 OAuth 流程；
- 显示账户（名称、plan、凭据到期时间）；
- 提供退出登录并删除本地凭据（不撤销远端会话）。

凭据由 pi-ai 自己的 store 通过 DSH 的 `credentials.modifyRecord` 写入，因此运行中的适配器能观测到提交，无需重启。

## 开发与构建

源码、辅助脚本和测试均使用 TypeScript；`npm run check` 严格检查插件及脚本，`npm run build` 使用 tsdown 构建服务端 ESM 和客户端 IIFE。客户端产物保留 DSH 的 `__ModuleLoader__.load` factory 协议，`lib/` 中的 JavaScript 与类型声明由构建生成，不手写或提交。`npm pack` 会先运行类型检查与构建。辅助脚本在 Node 22.19+ 下以 `--experimental-strip-types` 运行。

## 安装

### 使用发布安装包

从 [v0.3.10 GitHub Release](<https://github.com/tanuki-cat/dsh-codex/releases/tag/v0.3.10>) 下载 [安装包](<https://github.com/tanuki-cat/dsh-codex/releases/download/v0.3.10/dsh-llm-chatgpt-0.3.10.tgz>)，在下载目录执行：

```sh
dsh plugin --profile web add ./dsh-llm-chatgpt-0.3.10.tgz
```

该命令写入本机 `web` profile，请先备份其配置；旧版本遗留的 `llm-chatgpt` 配置项需按下述源码安装脚本的清理逻辑处理。功能源码已在 `0.3.10-dev.4` 上完成真实 profile 和原 GUI 验收；正式安装包另做类型检查、构建、测试和入口 smoke。当前发布渠道为 GitHub Release，尚未发布到 npm registry；不要使用 `npm install dsh-llm-chatgpt` 获取该版本。安装包不含开发脚本或测试。

### 从源码安装

本机 `web` profile 可在普通终端执行安装脚本：

```sh
node --experimental-strip-types ./scripts/install-local.ts
```

脚本调用 `dsh plugin` 安装当前包，已安装同版本时跳过；先备份 profile 配置，再移除早期版本遗留的 `llm-chatgpt` 配置项（0.3.0 起本插件不再声明 provider 路由，残留项会指向无人服务的路由），最后检查组合配置与插件模块导入。它不启动 Web 服务、不调用模型、不进行登录。

也可以手动安装：

```sh
npm install
npm pack --cache .npm-cache
dsh plugin --profile web add ./dsh-llm-chatgpt-0.3.10.tgz
```

本插件不需要在 `cordis.patch.yml` 中添加任何配置项。

## 使用

1. 重启 `dsh --profile web`；
2. 打开「设置 → 模型」；
3. 找到 `openai-codex` 那一行，点击卡片上的**登录 ChatGPT**；
4. 浏览器打开授权页，登录并允许；卡片会自动更新为已连接。

若 `openai-codex` 不在 provider 列表中，用模型页的「添加 → 从目录添加」（`addCatalog`）声明它——pi-ai 适配器只注册 profile 中已声明的路由，未声明的 provider 即使已登录也无法选择。该路由不需要 `apiKeyEnv`，留空才能让存储的 OAuth 凭据完成鉴权。

### 缺失模型补丁（预览后确认）

已有 OAuth 凭据且宿主提供可写设置时，卡片上的「检查缺失模型」会以当前账号查询 Codex 模型目录，将可见、能力信息足够的条目与现有可选模型比较。凭据即将过期时，复用宿主 pi-ai 的鉴权解析器，在同一个 DSH 凭据事务内刷新保存后重新读取；刷新失败显示具体原因。预览不写模型配置；仅在点击「确认补充缺失模型」后通过宿主设置服务写入。响应不向页面传输 OAuth 令牌；网络或模型来源不可用时**不使用旧 pi-ai catalog 猜测新增模型**，原配置保持不变。

补丁通过 `llm-pi-ai.providers.openai-codex.models` 保存；该字段会整体替换目录，插件在写入时保留已有模型及其显式配置。重复检查会并入新安装 pi-ai 中新增的原生模型 ID，但不覆盖已有自定义字段，目录不会后台自动同步。「检查恢复原生目录」会先列出被清除的显式能力配置及将不再可选的非原生模型；单独确认后将 `models` 设为空列表，恢复原生目录，其它路由设置不变。恢复不要求远端目录或 OAuth 可用；无法读取原生目录时拒绝恢复。补丁只能修复模型无法选中，不能修复账户无权限或旧版 pi-ai 缺少推理协议能力。`client_version` 优先使用 `DSH_CODEX_CLIENT_VERSION`（合法版本号），其次通过有界的 `codex --version` 探测本机 CLI，均不可用时采用内置 `0.160.1`；预览展示实际版本与来源。部分新模型的 `ultra` 推理等级无法由当前 pi-ai 表示，补丁只暴露宿主认识的等级，并在预览中以「未支持推理等级」列出被省略的等级。

上下文容量取**来源的 `context_window`**（模型自身的窗口），缺失时回退 `max_context_window`。端点同时返回两者，而 `max_context_window` 的语义是**配置覆盖允许达到的上限**、不是模型窗口，因此只作回退；这与上游 Codex 自己的 `resolved_context_window()` 一致。已显式写入的 `contextWindow` 不会被改写，低于或高于来源默认窗口都会提示；详情分别展示默认窗口与最大配置覆盖上限，供你检查设置或恢复原生目录。来源提供 `max_output_tokens` 时映射输出上限，没有时提示继承宿主默认值。

写入后对注册进行有界确认，只重查状态、不重试写入；界面区分目录信息、注册确认与未经验证的实际推理能力。模型能力、账号或配置变化仍会使确认失效，仅远端或运行时目录排序变化不会产生冲突。

此前已实测：插件以 DSH 存储的 OAuth 凭据可读取账号目录（HTTP 200，10 条，其中 7 条能力信息完整），且 `gpt-6.1-sol` 已在该路由上完成实际推理。验证细节与剩余偏差见 [实施方案](docs/design-task-feature-codex-missing-model-patches.md)。

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

## Codex 5 小时额度条

选择 `openai-codex` 时，输入栏模型选择器左侧展示账号共享的 5 小时额度使用条和已用百分比。悬浮或键盘聚焦可查看剩余百分比、重置时间、最后更新时间和查询状态；点击可再次检查，但受刷新间隔限制。

- 额度来自官方 Codex 客户端使用的 usage 接口，不按本会话 token 数估算；5 小时剩余不保证周额度、模型权限或其他限制仍可用。
- 服务端复用 DSH 存储的登录凭据，不向页面传递 OAuth token。成功查询缓存 60 秒，多会话请求合并；账号变化或退出登录会清除旧额度。
- 页面隐藏或离线时暂停轮询。网络暂时失败可展示同账号旧数据，最多五分钟且不跨重置时间；旧数据带标记。未知、未登录或不支持的窗口显示 `—`，不伪装成 0%。
- 首版仅在 loopback Web Host 的普通会话显示；远端 subagent 和无法确认路由的会话隐藏。不支持额度槽位的旧宿主仍保留设置页登录。
- 该后端接口不是稳定公开 API；字段或权限改变时降级为未知额度，不影响发送消息。

实现方案和验证边界见 [额度条方案](<docs/design-task-feature-codex-five-hour-usage-bar.md>)。本功能属于 `0.3.10`，通过 GitHub Release 提供安装包，未发布到 npm。发布边界见 [0.3.10 发布说明](<docs/design-task-release-codex-five-hour-usage-0.3.10.md>)。

## 当前限制

- 不实现模型推理协议；图片输入、WebSocket 传输等仍由官方 pi-ai 实现。
- 只在预览并确认后补充缺失模型，不提供通用模型编辑，也不自动修改默认模型。
- 设置页账户信息来自凭据中的 JWT 声明（名称、plan、到期时间）；额度条单独请求 usage 接口，凭据到期时间不是额度重置时间。

## 验证范围

`npm run check` 对插件与辅助脚本做严格类型检查；`npm test` 先用 tsdown 构建，再使用 Node 内建测试运行器。`tests/codex.test.ts` 覆盖 flow 缺失、登录通知、提交后状态、取消与退出、令牌不泄漏与 capability 校验；`tests/client.test.ts` 用模拟模块加载器渲染真实 factory，覆盖卡片只在 `openai-codex` 行渲染、样式表生命周期、已连接 / 未连接 / 无 flow / 接口失败四种状态，以及授权 URL 延迟到达、状态轮询、popup 回退与取消入口。

`tests/installed-codex.test.ts` 通过 `DSH_INSTALL_ROOT` 指定安装目录，用真实 `AuthorizationService` 与 `webServer` 验证端点注册与 index 注入；`tests/model-patches.test.ts` 覆盖远端列表解析、保真合并、revision 冲突、降级拒写与各条安全失败分支；`tests/installed-model-patches.test.ts` 挂载真实 `dsh-llm-pi-ai` 适配器与真实模型解析器，验证补丁结果能通过宿主 `Config` schema、写入后模型可解析（补丁前为 `UNKNOWN_MODEL`）、目录模型不丢失、热更新生效与幂等：

```sh
DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test
```

`tests/host-catalog.test.ts` 还覆盖请求版本选择、刷新事务与并发避免重复旋转；`tests/installed-host-catalog.test.ts` 用真实 pi-ai 鉴权解析器验证同一个 DSH 凭据事务中的刷新行为，但使用替身令牌交换，不连接真实 OAuth endpoint。

另有断言覆盖令牌不外泄：驱动全部管理路由并检查每个响应体与 index 注入脚本，OAuth access/refresh 与签名均不出现。

**未覆盖**：真实 `SettingsForms` 的设置写入本身——它需要完整 Loader 与 profile-boot 链，测试中的设置服务仍是替身，因此「`configEditor.edit` 真正落盘到 `cordis.patch.yml`」由宿主而非本插件的测试保证。来源列表的服务端更新频率需要跨时间采样，单次实现无法证明。真实浏览器点击完成一次 OAuth 授权与人工回退操作同样未留存记录。

## 与 0.2.x 的区别

0.2.x 是本插件的早期形态：一个自带协议实现的独立 `chatgpt-plan` provider，包含 OAuth、Responses 协议、SSE 转换与模型目录，约 640 行，另加一个订阅管理页。

0.3.0 删除了全部协议实现，改为官方 `openai-codex` 路由的界面扩展。旧订阅页与 `chatgpt-plan` 路由一并移除；该路由的历史会话无法继续发送消息，但历史内容保留。

早期版本的改动记录见 [设计文档](docs/design-task-add-chatgpt-subscription-plugin.md)，方案 A 的实施与验证见 [登录入口设计文档](docs/design-task-openai-codex-in-plugin-login.md)。
