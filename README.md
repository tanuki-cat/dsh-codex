---
description: "在 DSH 中登录 ChatGPT、补充 Codex 缺失模型、恢复原生目录并查询 5 小时与周剩余额度。"
kind: "package-reference"
---

# dsh-llm-chatgpt

## 概要

在 DSH 设置页登录 ChatGPT，预览并确认补充 Codex 缺失模型或恢复原生目录，在本机会话查看账号共享的 5 小时剩余额度，并通过 `/usage` 查询周额度。OAuth 和推理协议由宿主 pi-ai 提供；可选模型和剩余额度不保证账号实际有权调用。

## 目录

- [安装](#安装)
- [使用与模型补丁](#使用)
- [Codex usage 命令](#codex-usage-命令)
- [Codex 5 小时额度条](#codex-5-小时额度条)
- [网络](#网络)
- [当前限制](#当前限制)
- [开发与构建](#开发与构建)
- [辅助脚本](#辅助脚本)
- [验证范围](#验证范围)
- [文档索引与历史记录](#文档索引与历史记录)

## 这个插件做什么

DSH 的 `@deepseek-ai/dsh-llm-pi-ai` 已内置官方实现：它直接引入 `@earendil-works/pi-ai`，其中包含 `openai-codex` provider——端点、协议、模型目录、OAuth 与凭据刷新全部由 pi-ai 提供。

本插件使用 `settings.models.provider-card` 扩展模型设置页，在 `llm-pi-ai` 的 `openai-codex` 行展示账号登录与模型补丁入口。宿主未提供对应授权 flow 时，卡片不显示；未提供可写模型设置时，不能应用补丁。

本插件补上登录入口，并通过宿主 API 管理模型配置；**不另实现 OAuth 或推理协议**：

- 在模型设置页的 `openai-codex` provider 卡片上渲染登录按钮；
- 点击后驱动 pi-ai 自己的 OAuth 流程；
- 显示账户（名称、plan、凭据到期时间）；
- 在普通本机 Codex 会话显示账号共享的 5 小时剩余额度，提供 `/usage` 查询 5 小时与周额度；
- 提供退出登录并删除本地凭据（不撤销远端会话）；
- 预览并确认补充缺失模型，重复检查时并入新安装的原生模型 ID；
- 预览并单独确认恢复原生目录，明确列出被清除的显式模型配置及不可选模型。

凭据由 pi-ai 自己的 store 通过 DSH 的 `credentials.modifyRecord` 写入，因此运行中的适配器能观测到提交，无需重启。

## 安装

### 前置条件

- Node.js `^22.19.0 || >=24.0.0`，与[包声明](<package.json>)一致。
- 已安装 DSH 并有 `web` profile；本地安装脚本只接受声明的宿主版本 `0.2.0-rc.2` 或 `0.2.1-alpha.1`。真实 GUI 验收环境为 `0.2.1-alpha.1`，不据此承诺所有版本或平台兼容。
- 宿主挂载 `llm-pi-ai` 并提供 `openai-codex` 授权 flow；登录 UI 还需要 Web 服务和模型设置页。额度条要求模型目录、会话、连接服务及 `conversation.input.right` 槽位。

### 使用发布安装包

从 [v0.3.11 GitHub Release](<https://github.com/tanuki-cat/dsh-codex/releases/tag/v0.3.11>) 下载 [安装包](<https://github.com/tanuki-cat/dsh-codex/releases/download/v0.3.11/dsh-llm-chatgpt-0.3.11.tgz>)，在下载目录执行：

```sh
dsh plugin --profile web add ./dsh-llm-chatgpt-0.3.11.tgz
```

该命令写入本机 `web` profile，请先备份其配置；旧版本遗留的 `llm-chatgpt` 配置项需按下述源码安装脚本的清理逻辑处理。用户已反馈 `0.3.11-dev.2` 安装测试通过；正式版本保持该开发版功能源码，另做类型检查、构建与安装包 smoke。验收项及限制见 [0.3.11 发布说明](<docs/design-task-release-codex-usage-0.3.11.md>)。当前发布渠道为 GitHub Release，尚未发布到 npm registry；不要使用 `npm install dsh-llm-chatgpt` 获取该版本。安装包不含开发脚本或测试。

安装后重启对应 DSH Web 进程并重新加载页面，加载新的服务端命令与客户端卡片；不能仅靠浏览器刷新更新服务端插件。升级自开发版同样需要安装正式包。

### 从源码安装

在已检出的仓库根目录，先安装依赖并生成当前版本安装包，再在普通终端运行安装脚本。脚本只读取现有 `.tgz`，不会自动构建或打包：

```sh
npm install
npm pack --cache .npm-cache
node --experimental-strip-types ./scripts/install-local.ts
```

脚本调用 `dsh plugin` 安装当前包，已安装同版本时跳过；先备份 profile 配置，再移除遗留的 `llm-chatgpt` 配置项，最后检查组合配置与插件模块导入。默认使用 `~/.dsh/profiles/web`，可用 `DSH_HOME` 指定另一 DSH 根目录，但 profile 固定为 `web`。备份保存在该 profile 的 `.chatgpt-install-backups`。验证失败时恢复脚本改写的 patch，不卸载已安装的包；检查备份和错误信息后再重试。它不启动 Web 服务、不调用模型、不进行登录。

也可以在仓库根目录手动构建并安装：

```sh
npm install
npm pack --cache .npm-cache
dsh plugin --profile web add ./dsh-llm-chatgpt-0.3.11.tgz
```

本插件不需要在 `cordis.patch.yml` 中添加任何配置项。

## 使用

1. 重启 `dsh --profile web`；
2. 打开「设置 → 模型」；
3. 找到 `openai-codex` 那一行，点击卡片上的**登录 ChatGPT**；
4. 浏览器打开授权页，登录并允许；卡片会自动更新为已连接。

若 `openai-codex` 不在 provider 列表中，用模型页的「添加 → 从目录添加」（`addCatalog`）声明它——pi-ai 适配器只注册 profile 中已声明的路由，未声明的 provider 即使已登录也无法选择。该路由不需要 `apiKeyEnv`，留空才能让存储的 OAuth 凭据完成鉴权。

### 缺失模型补丁（预览后确认）

已有 OAuth 凭据且宿主提供可写设置时，卡片上的「检查缺失模型」会以当前账号查询 Codex 模型目录，将可见、能力信息足够的条目与现有可选模型比较。已知到期时间不足五分钟且存在 refresh token 时，复用宿主 pi-ai 的鉴权解析器，在同一个 DSH 凭据事务内刷新保存后重新读取。自动刷新还要求宿主公开 API 兼容、凭据存储可写及网络可用；不具备这些条件或刷新失败时提示重试或重新登录。预览不写模型配置，但可能刷新已存 OAuth 凭据；仅在点击「确认补充缺失模型」后通过宿主设置服务写入。响应不向页面传输 OAuth 令牌；网络或模型来源不可用时**不使用旧 pi-ai catalog 猜测新增模型**，原配置保持不变。

补丁通过 `llm-pi-ai.providers.openai-codex.models` 保存；该字段会整体替换目录，插件在写入时保留已有模型及其显式配置。重复检查会并入新安装 pi-ai 中新增的原生模型 ID，但不覆盖已有自定义字段，目录不会后台自动同步。「检查恢复原生目录」会先列出被清除的显式能力配置及将不再可选的非原生模型；单独确认后将 `models` 设为空列表，恢复原生目录，其它路由设置不变。恢复不要求远端目录或 OAuth 可用；无法读取原生目录时拒绝恢复。这不是撤销上一次补丁：全部显式条目及其自定义能力字段都会被清空，请先检查预览并备份需要保留的值。补丁只能修复模型无法选中，不能修复账户无权限或旧版 pi-ai 缺少推理协议能力。`client_version` 优先使用 `DSH_CODEX_CLIENT_VERSION`（合法版本号），其次通过有界的 `codex --version` 探测本机 CLI，均不可用时采用内置 `0.160.1`；预览展示实际版本与来源。部分新模型的 `ultra` 推理等级无法由当前 pi-ai 表示，补丁只暴露宿主认识的等级，并在预览中以「未支持推理等级」列出被省略的等级。

上下文容量取**来源的 `context_window`**（模型自身的窗口），缺失时回退 `max_context_window`。端点同时返回两者，而 `max_context_window` 的语义是**配置覆盖允许达到的上限**、不是模型窗口，因此只作回退；这与上游 Codex 自己的 `resolved_context_window()` 一致。已显式写入的 `contextWindow` 不会被改写，低于或高于来源默认窗口都会提示；详情分别展示默认窗口与最大配置覆盖上限，供你检查设置或恢复原生目录。来源提供 `max_output_tokens` 时映射输出上限，没有时提示继承宿主默认值。

写入后对注册进行有界确认，只重查状态、不重试写入；界面区分目录信息、注册确认与未经验证的实际推理能力。模型能力、账号或配置变化仍会使确认失效，仅远端或运行时目录排序变化不会产生冲突。

确认遇到 `conflict` 时重新检查并查看新预览。遇到 `registration-unconfirmed` 表示配置已保存，但有界重查未确认注册；先核对模型设置和可选目录，不要视为“没有写入”而反复确认。插件不自动撤销已保存配置。无效的 `DSH_CODEX_CLIENT_VERSION` 会使检查失败，不会静默改用 CLI 或内置版本。

此前已实测：插件以 DSH 存储的 OAuth 凭据可读取账号目录（HTTP 200，10 条，其中 7 条能力信息完整），且 `gpt-6.1-sol` 已在该路由上完成实际推理。这些实测对应旧版实现，见 [0.3.8 历史方案](<docs/design-task-feature-codex-missing-model-patches.md>)，不能替代当前版本的真实推理验收。0.3.9 的逐项修复、未消除的风险及验证边界见[处理记录](<docs/design-task-fix-codex-model-patch-review-0.3.9.md>)和[更新日志](<CHANGELOG.md>)。

## 网络

登录与推理都访问 `auth.openai.com` 与 `chatgpt.com`。若需要代理，导出标准环境变量即可，DSH 的进程级代理策略会让所有基于 `fetch` 的出站走代理：

```sh
# ~/.dsh/.env
https_proxy=http://127.0.0.1:7890
http_proxy=http://127.0.0.1:7890
no_proxy=localhost,127.0.0.1,::1
```

loopback 流量始终绕过代理，因此本机 Web UI 与 OAuth 回调不受影响。

## Codex usage 命令

登录 ChatGPT 后，在对话输入框提交无参数命令 `/usage`，直接展示账号的 5 小时与周额度，不调用模型。需要宿主提供 commands 服务；没有该服务的旧宿主仍可使用设置页登录和额度条。

支持专用命令槽位的宿主中，结果默认展开为双窗口额度卡片；宽屏并排、窄屏上下排列，折叠后只显示两项简短百分比摘要。显示真正的彩色进度条，不在界面中拼接字符方块；旧历史文本可转换为卡片，无法识别的内容和错误保留为纯文本。无专用槽位的旧宿主仍显示原始文本。结果以剩余优先，附带已用百分比、完整重置日期、查询时间和宿主本地时区。进度条表示剩余比例；不将百分比估算为 token 数或请求次数。命令时区可能与远程浏览器不同。缺失、无效或已重置窗口分别提示，另一窗口仍可显示；未知重置时间不会猜测。

主动查询距同账号最近实际查询不足一分钟时返回缓存并标注；超过一分钟可重新查询，但不能绕过失败退避和 Retry-After。查询与额度条共用缓存和并发请求，结果不包含账号 ID、邮箱或 OAuth token。暂时失败时仅保留十五分钟内且尚未重置的旧窗口，并显示失败和旧数据提示。

## Codex 5 小时额度条

选择 `openai-codex` 时，输入栏模型选择器左侧展示账号共享的 5 小时剩余额度条和“剩余可用”百分比。填充比例和无障碍进度值均表示剩余；正常为绿色，剩余 ≤20% 为橙色、≤5% 为红色；命令卡片与输入栏额度条一致。悬浮或键盘聚焦可查看剩余与已用比例、重置时间、最后更新时间和查询状态；点击可再次检查，但不绕过刷新间隔。

- 额度来自官方 Codex 客户端使用的 usage 接口，不按本会话 token 数估算；5 小时剩余不保证周额度、模型权限或其他限制仍可用。
- 服务端复用 DSH 存储的登录凭据，不向页面传递 OAuth token。查询不要求模型设置可写；临近过期的凭据刷新需要兼容的宿主 API 和可写凭据存储。成功查询供自动轮询缓存五分钟，最早窗口重置会提前触发检查；同一服务实例内多会话请求合并，账号变化或退出登录清除旧额度。每个窗口到达重置时间即停止显示其旧值，不影响另一仍有效的窗口。
- 首次显示立即查询，正常自动轮询间隔五分钟；页面隐藏或离线时暂停。客户端最短检查间隔一分钟，还需遵守服务端再次检查时间；点击不会绕过缓存或失败退避。正常五分钟周期内不标旧，网络暂时失败可保留同账号旧数据至十五分钟，但不跨对应窗口重置时间；旧数据带标记。未知、未登录或不支持的窗口显示 `—`，不伪装成 0%。
- 首版仅在 loopback Web Host 的普通会话显示；远端 subagent 和无法确认路由的会话隐藏。不支持额度槽位的旧宿主仍保留设置页登录。
- 该后端接口不是稳定公开 API；字段或权限改变时降级为未知额度，不影响发送消息。

当前命令、卡片与显示行为的版本边界见 [0.3.11 发布说明](<docs/design-task-release-codex-usage-0.3.11.md>)。初版查询实施记录见 [usage 实施方案](<docs/design-task-feature-codex-usage-command.md>)；`0.3.10` 的历史额度条边界见 [0.3.10 发布说明](<docs/design-task-release-codex-five-hour-usage-0.3.10.md>)。

## 当前限制

- 不实现模型推理协议；图片输入、WebSocket 传输等仍由官方 pi-ai 实现。
- 只在预览并确认后补充缺失模型，不提供通用模型编辑，也不自动修改默认模型。
- 设置页账户信息来自凭据中的 JWT 声明（名称、plan、到期时间）；额度条单独请求 usage 接口，凭据到期时间不是额度重置时间。

## 开发与构建

源码、辅助脚本和测试均使用 TypeScript；`npm run check` 严格检查插件及脚本，`npm run build` 使用 tsdown 构建服务端 ESM 和客户端 IIFE。客户端产物保留 DSH 的 `__ModuleLoader__.load` factory 协议，`lib/` 中的 JavaScript 与类型声明由构建生成，不手写或提交。`npm pack` 会先运行类型检查与构建。辅助脚本在 Node 22.19+ 下以 `--experimental-strip-types` 运行。

## 辅助脚本

`scripts/login-openai-codex.ts` 和 `scripts/add-openai-codex-route.ts` 是为没有设置页入口的旧版环境保留的手工排障工具，当前安装流程不会调用。正常使用优先通过模型设置页登录并用「从目录添加」声明路由。

## 验证范围

`npm run check` 对插件与辅助脚本做严格类型检查；`npm test` 先用 tsdown 构建，再使用 Node 内建测试运行器。`tests/codex.test.ts` 覆盖 flow 缺失、登录通知、提交后状态、取消与退出、令牌不泄漏与 capability 校验；`tests/client.test.ts` 用模拟模块加载器渲染真实 factory，覆盖卡片只在 `openai-codex` 行渲染、样式表生命周期、已连接 / 未连接 / 无 flow / 接口失败四种状态，以及授权 URL 延迟到达、状态轮询、popup 回退与取消入口。

`tests/installed-codex.test.ts` 通过 `DSH_INSTALL_ROOT` 指定安装目录，用真实 `AuthorizationService` 与 `webServer` 验证端点注册与 index 注入；`tests/model-patches.test.ts` 覆盖远端列表解析、保真合并、revision 冲突、降级拒写与各条安全失败分支；`tests/installed-model-patches.test.ts` 挂载真实 `dsh-llm-pi-ai` 适配器与真实模型解析器，验证补丁结果能通过宿主 `Config` schema、写入后模型可解析（补丁前为 `UNKNOWN_MODEL`）、目录模型不丢失、热更新生效与幂等：

```sh
DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test
```

[宿主目录测试](<tests/host-catalog.test.ts>)覆盖请求版本选择、刷新事务与并发避免重复旋转；[宿主鉴权集成测试](<tests/installed-host-catalog.test.ts>)用真实 pi-ai 鉴权解析器验证同一个 DSH 凭据事务中的刷新行为，但使用替身令牌交换，不连接真实 OAuth endpoint。

[额度服务测试](<tests/usage.test.ts>)覆盖双窗口识别、独立重置、响应大小、超时、账号隔离、缓存合并、主动查询限频、退避和刷新；[额度客户端测试](<tests/client-usage.test.ts>)覆盖五分钟边界、隐藏/离线、旧数据到期、晚到响应、剩余填充、色阶及独立进度语义。[命令测试](<tests/usage-command.test.ts>)覆盖文本、缓存、错误和取消；[命令宿主集成](<tests/installed-usage-command.test.ts>)用真实 CommandRuntime 验证发现、执行、日志和卸载，网络与会话存储使用替身。[客户端集成测试](<tests/client.test.ts>)还验证额度条在真实已安装 Host SlotCore 中注册并与其它 list 贡献共存。

不设置 `DSH_INSTALL_ROOT` 时，依赖已安装宿主的集成测试会跳过；上述路径是本机示例，请替换为实际 DSH 安装目录。

另有断言覆盖令牌不外泄：驱动全部管理路由并检查每个响应体与 index 注入脚本，OAuth access/refresh 和 JWT 签名片段均不出现；用于补丁确认的预览签名不是 OAuth 密钥，会按接口契约返回。

**自动化测试未覆盖**：真实 `SettingsForms` 的 profile 落盘、真实 OAuth 令牌交换及完整浏览器授权。设置服务和网络交换使用替身，客户端回归使用模拟浏览器环境；集成测试通过不证明真实账号授权、原生目录恢复或完整推理成功。来源列表的服务端更新频率也需要跨时间采样。

额度条的既有真实 GUI 验收和未覆盖项目见 [0.3.10 发布说明](<docs/design-task-release-codex-five-hour-usage-0.3.10.md#未覆盖与风险>)。历史实测不代替当前版本的真实环境验收。

## 文档索引与历史记录

[文档索引](<docs/README.md>)区分当前使用入口、版本处理记录和冻结的历史方案。历史记录中的源码路径、接口及实测数据只对应其标注版本，不代替当前源码或验收。

### 0.2.x 历史兼容说明

0.2.x 是本插件的早期形态：一个自带协议实现的独立 `chatgpt-plan` provider，包含 OAuth、Responses 协议、SSE 转换与模型目录，约 640 行，另加一个订阅管理页。

0.3.0 删除了全部协议实现，改为官方 `openai-codex` 路由的界面扩展。旧订阅页与 `chatgpt-plan` 路由一并移除；该路由的历史会话无法继续发送消息，但历史内容保留。

早期版本的改动记录见 [设计文档](docs/design-task-add-chatgpt-subscription-plugin.md)，方案 A 的实施与验证见 [登录入口设计文档](docs/design-task-openai-codex-in-plugin-login.md)。
