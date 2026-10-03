# dsh-llm-chatgpt

将 ChatGPT Plus / Pro 订阅接入 DeepSeek Harness 的独立 LLM 插件。采用官方 [Sign in with ChatGPT 开源客户端流程](https://developers.openai.com/siwc/token-sharing-open-source)，通过 OAuth 授权订阅使用权限，再调用公开 Responses API。DSH 负责工具执行和会话管理。

已通过本地协议测试和本机 DSH 核心服务加载测试，**尚未完成真实账户及浏览器 Web profile 联调**。账户必须具备官方接入资格并授权 ChatGPT plan usage；订阅额度和模型可用性以 OpenAI 返回为准。

## 功能

- 浏览器 OAuth 登录，PKCE / state / nonce 和 RS256 身份校验。
- DSH 凭据服务存储令牌；临近过期时在存储锁内自动刷新。
- 账户模型列表、流式文本、推理摘要、函数工具调用及工具结果往返。
- 完整历史和加密推理项重放；缓存 token 与普通输入 token 分开统计。
- 登录、账户状态、远程撤销与退出命令。
- 设置侧栏 ChatGPT 管理页：浏览器登录、自动显示结果、账户状态、可用模型和退出撤销。
- 可配置 HTTP / HTTPS 代理，用于 OAuth、刷新、模型目录和推理请求。

## 安装到 DSH

需要 Node.js `^22.19.0 || >=24.0.0`（测试环境 22.23.3）和 DSH `0.2.0-rc.2` 或 `0.2.1-alpha.1`。插件 0.2.3 精确声明这两个已核对版本，前者已用本机真实安装依赖验证，后者通过本地源码接口测试验证。Web 管理页使用宿主的 webServer、webRuntime、client-modules、settings.section 与 locale 服务；这些服务由标准 Web profile 提供。命令入口还需 `commands`、`userQuestions` 及其 UI 提供者。

本机现有 `web` profile 可在普通终端执行安装脚本：

```sh
node /Users/wangzy/WorkSpace/WebStormProjects/dsh-codex/scripts/install-local.mjs
```

需要本机代理时使用：

```sh
node /Users/wangzy/WorkSpace/WebStormProjects/dsh-codex/scripts/install-local.mjs --proxy http://127.0.0.1:7890
```

若账户模型目录暂未列出 `gpt-6.1-sol`，可显式增加一个待验证的手动选项：

```sh
node /Users/wangzy/WorkSpace/WebStormProjects/dsh-codex/scripts/install-local.mjs --proxy http://127.0.0.1:7890 --model gpt-6.1-sol
```

此命令只把模型加入选择器，名称标记 `manual; verify access`；它不证明账户已获该模型的订阅调用权限。只有真正完成一次推理请求才能验证。此参数合并到 profile，重启 DSH 后生效。

此参数合并到 profile 的 `llm-chatgpt` 配置，保存后重启 DSH 生效。可以使用 `--proxy ""` 清除显式代理、恢复 DSH 原有网络策略。

脚本调用 `dsh plugin` 安装当前包，已安装同版本时跳过重复安装；先备份现有 profile 配置，再合并插件配置项并检查组合配置及插件模块导入。Schema 检查比较安装前后的诊断：已有 profile 的导出不完整但本插件没有新增问题时允许继续并明确提示；插件导入失败、新增诊断或命令异常仍会拒绝。它不启动 Web 服务、不调用模型、不进行 ChatGPT 登录。当前 Codex 沙箱不能写入 `~/.dsh`，因此需要从本机终端执行。下面是手动安装步骤。

在本项目目录打包：

```sh
npm run check
npm test
npm pack --cache .npm-cache
```

将生成的 tarball 安装到自己的 profile，例如已有的 `web` profile：

```sh
dsh plugin --profile web add /Users/wangzy/WorkSpace/WebStormProjects/dsh-codex/dsh-llm-chatgpt-0.2.3.tgz
```

新版 DSH base 已提供 `authorization` 服务。只有自定义 profile 缺失该服务时，才需要安装与宿主版本一致的 `@deepseek-ai/dsh-authorization` 并添加对应配置项。不要引入不同版本的 DSH 核心服务。

将 [examples/cordis.patch.yml](examples/cordis.patch.yml) 的配置项合并到 `$DSH_HOME/profiles/web/cordis.patch.yml`；示例只插入本插件。升级已有配置时更新原来的 `llm-chatgpt` 项，不要重复插入；若曾额外插入授权服务，应检查并消除与新版 base 的重复服务项。保留 profile 原有内容。此插件不是自动安装的 Bundle，安装 npm 包后仍需显式添加配置项。

重启 profile：

```sh
dsh --profile web
```

打开“设置”，在左侧选择“ChatGPT”。页面显示连接状态及账户信息，点击 **Continue with ChatGPT** 会打开浏览器授权窗口。OAuth 完成后页面自动更新状态和模型列表，无需手动确认；浏览器阻止弹窗时使用页面中的“打开浏览器完成授权”链接。登录期间可取消；已连接时可刷新模型或退出并撤销会话。

页面显示当前模型路由、回调端口和请求超时供核对。配置参数仍通过 profile 配置文件修改；选择模型沿用 DSH 的模型选择器。管理页不会自动修改默认模型，也不显示 OAuth 凭据。订阅使用说明遵循 [OpenAI 官方 UI 指引](https://developers.openai.com/siwc/ui-ux-guidelines)。

也可以在 DSH 会话中使用保留的命令入口：

```text
/chatgpt-plan-login
```

问题框将展示本机登录链接。打开它，在浏览器中登录 ChatGPT 并允许订阅使用。浏览器收到回调后即可返回 DSH；如果问题框仍显示，可选择“已完成浏览器登录”。最终命令结果才表示登录是否成功，问题选项本身不能替代 OAuth 授权。

登录后刷新模型列表或重新打开界面，选择 provider `chatgpt-plan` 和账户返回的模型，再发送消息。插件不会自动改变原有默认模型。

```text
/chatgpt-plan-status
/chatgpt-plan-logout
```

退出会撤销 refresh session 并清除本地令牌，保留账户/client 映射用于下次登录。远程撤销失败时保留凭据以便重试，并显示失败；也可以在 ChatGPT Settings 中断开应用。不同账户可以用不同的 `provider` 配置实例保存，命令名称随 provider 改变。

## 配置

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `provider` | `chatgpt-plan` | 独立模型路由及账户记录标识；小写字母、数字、连字符，不能为 `host` |
| `callbackPort` | `0` | 本机回调端口；0 自动选择可用端口 |
| `requestTimeoutMs` | `600000` | 单次推理请求总超时，单位毫秒 |
| `proxyUrl` | 空 | HTTP / HTTPS 代理地址，例如 `http://127.0.0.1:7890`；空值沿用 DSH 网络策略 |
| `extraModels` | `[]` | 显式加入选择器的模型 ID，例如 `["gpt-6.1-sol"]`；是否有权调用由账户和 API 决定 |

显式代理只作用于本插件，不修改其他插件的全局网络设置。OAuth token / JWKS、刷新、撤销、模型列表及 SSE 推理均通过同一代理；本机回调监听器和浏览器由其各自网络设置管理。管理页显示当前代理地址，但参数仍通过 profile 修改。仅支持 HTTP / HTTPS 代理，不支持 SOCKS 或内嵌代理账号密码；采用宿主已携带的 `undici`（^8.11.2）ProxyAgent，未配置时不加载该模块。显式代理连接失败不会自动回退直连。

浏览器回调仅监听 `127.0.0.1`，登录超时为 5 分钟。远程部署时需在浏览器所在机器转发配置的固定回调端口；自动端口模式适用于 DSH 和浏览器运行在同一机器。登录地址不携带访问令牌或刷新令牌。

凭据记录地址是 `llm-chatgpt/<provider>`，稳定主机 ID 保存于 `llm-chatgpt/host`。存储保护及跨进程排他由 DSH credentials backend 提供；生产应使用提供受保护文件与跨进程锁的实现。

登录通过 `credentials.modifyRecord` 在同一锁内检查凭据快照并提交，新版授权服务通过凭据更新事件确认成功。`session.commit(record)` 不支持条件更新，因此此处保留直接写入方式，避免覆盖 OAuth 期间发生的凭据刷新；取消检查在写入回调内执行。

## 首版限制

仅接受文本及函数工具结果，图片内容会明确拒绝。`temperature` / `maxTokens` 不发送，因为订阅预览接口不支持这些参数；非空 `stop` 会明确拒绝。DSH 辅助标题请求的输出长度限制因此由模型和宿主后处理决定。没有配置静态 context window 或推理等级目录；宿主可使用其自身默认策略。

工具结果采用 DSH 新版独立 `tool` 消息，使用顶层 `toolCallId` 关联 Responses 的 `function_call_output`。未声明工具动态更新模式：由 DSH LlmRuntime 将 developer 更新消息投影为当前工具声明；直接向适配器传入未经投影的 developer 消息会被拒绝。旧版 `tool-result` 内容块不属于本版本支持的输入接口。

模型列表优先取自账户的 `/v1/models`，只展示 `visibility: list` 条目；配置的 `extraModels` 随后追加并明确标记为手动项。已知模型的思考强度依照官方模型文档展示；未知 ID 不臆测支持的档位。`gpt-6.1-sol` 仅展示 `low`、`medium`、`high`、`xhigh`、`max`，无 `none` / `minimal`；未选择强度时沿用服务端默认。没有 API Key 计费回退，也不会读取 Codex 的登录文件。订阅使用受账户额度约束，具体见 [账户与用量说明](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)；接口参数限制见 [官方预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。

## 验证范围

0.2.2 修复了空重放元数据导致工具调用被丢弃、后续只发送工具结果而返回 HTTP 400 的问题。已有会话中的空或不完整重放数据自动回退到实际消息内容，无需删除会话；新的流优先保存已完成的原生输出项。已用本机失败会话日志验证重建后的调用和结果 ID 匹配，62 个测试通过。真实 API 重试结果仍需升级后验证。

`npm test` 使用 Node 内建测试运行器，执行真实 OAuth 校验、JWT 签名验证、请求构造、刷新及 SSE 转换代码。外部 OpenAI 响应使用模拟数据，插件注册测试使用宿主接口替身；它们不证明真实账号已接通。

`tests/dsh-source.test.js` 在存在相邻 `deepseek-harness` 仓库时，执行其真实消息构造、工具投影和 AuthorizationService 源码，验证本插件的提交与消息转换；Cordis 基础服务和凭据存储仍为测试替身，不等同于完整宿主启动。其他路径可通过 `DSH_SOURCE_ROOT` 指定；缺少源码时该组测试明确跳过。TypeScript 去类型仅用于这组测试，插件运行时仍为普通 JavaScript。

`tests/installed-dsh.test.js` 通过 `DSH_INSTALL_ROOT` 指定安装目录，使用真实 Cordis、LlmRuntime、AuthorizationService 和 CredentialProvider 验证插件注册及工具结果推理请求；仅凭据后端和外部响应为模拟数据。

```sh
DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test
```

本机验证覆盖 DSH 源码、真实已安装的 DSH 依赖、管理路由、index 注入、安装配置合并及失败回滚、浏览器管理模块与代理传输。真实依赖测试实例化宿主 ProxyAgent 并验证其传入推理请求；代理与外部服务的网络连接仍使用模拟响应。浏览器 UI 的注册、弹窗行为和状态控制器使用模拟环境验证，尚无真实 OAuth 联调结果。

首次联调应确认：插件无依赖注入缺失；登录后显示成功；模型目录返回；一轮真实回答完成；DSH 工具调用完成并发送结果；重启后仍能读取凭据；退出能够撤销会话。网络受限环境下，本项目未安装宿主依赖，也未执行上述真实联调。

实施范围见 [设计文档](docs/design-task-add-chatgpt-subscription-plugin.md)。
