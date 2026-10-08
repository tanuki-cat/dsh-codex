# ChatGPT 订阅接入 DSH

> 版本归属：本文记录 0.2.x 自建 `chatgpt-plan` provider 的历史实现及排障过程。该 provider 已在 0.3.0 移除，旧配置、文件路径和验证记录不作为当前安装说明。当前入口与能力边界见 [README](<../README.md>)，0.3.9 模型补丁处理结果见[后续记录](<design-task-fix-codex-model-patch-review-0.3.9.md>)。

## 模型目录与思考强度

本机已登录账户的 DSH 模型选择器展示五个账户目录模型，缺少 gpt-6.1-sol；现有适配器只转发 `GET /v1/models` 中 `visibility=list` 的条目，且 `resolveModel()` 未提供 `reasoning` 元数据，因此 DSH 没有思考强度选项。官方说明该 endpoint 是账户模型目录；公开模型文档列出 gpt-6.1-sol 及其 reasoning.effort，但公开文档不证明该账户已获授权。

插件 0.2.3 为目录中已知模型返回 DSH 的 exact model reasoning 努力级别，不为未知模型推断级别。gpt-6.1-sol 使用 low / medium / high / xhigh / max，排除 none、minimal；GPT-6 Astra 同组；GPT-5.6 Sol / Terra / Luna 使用 none / low / medium / high / xhigh / max；GPT-5.5 使用 none / low / medium / high / xhigh。省略强度时沿用服务端默认，避免改写既有会话行为。选择时按现有 Responses `reasoning.effort` 传输。

额外提供显式 `extraModels` profile 配置及安装脚本 `--model gpt-6.1-sol`，将指定模型以“手动添加，需账户权限”描述合并到选择器，不把其当作账户目录返回或默认为可用。仅当已连接账户后展示；去重、规范化和错误配置需验证。界面显示来源区分，配置保存在 profile。真实调用是否获准须升级后用该账户发起请求验证，失败时仍保留精确 HTTP 状态。

## 工具结果 HTTP 400 修复

本机失败会话 session-c3b34d90-901a-4387-9061-346471f0b2dd 的第一步成功生成 run_code 调用，第二步返回 400。assistant/message 保存了工具调用，但 replayState.response.items=[]；requestBody 使用该空数组并跳过实际消息内容，最终只发送 function_call_output，没有对应 function_call。后续轮次复用相同历史继续失败。

0.2.2 修复：仅在重放数据非空且完整对应文本与工具调用时采用；否则从消息内容重建请求，兼容已保存的坏重放数据。流解析保留 response.output_item.done 的原生项目；终态 output 为空时使用这些已完成项目，避免丢失 reasoning / function_call。终态与项目均不足时不保存重放数据。新增空终态流、已有空重放会话、部分重放与两轮工具结果回归测试；不修改用户会话文件。

验证结果：62 个测试通过，无跳过，语法检查通过。使用本机失败会话的 seq 18 assistant/message 与 seq 22 tool/result 重建请求，输入从只有 function_call_output 修复为 function_call + function_call_output，call_id 一致。未提交真实模型请求，也未改写日志或安装目录；用户升级后需重试确认真实 API 接受。

## 显式 HTTP 代理

插件 0.2.1 增加 proxyUrl 配置，接受 HTTP / HTTPS 代理以及省略协议的 host:port，常用值为 http://127.0.0.1:7890。空值继续使用 DSH 原有进程网络策略。使用宿主已携带的 undici ProxyAgent，为本插件的 fetch 指定独立 dispatcher，不更改进程全局代理。OAuth token / JWKS、刷新、撤销、模型列表和推理请求均使用同一个代理传输；浏览器和本机 OAuth 回调不走此代理。禁止代理 URL 内嵌凭据，管理页只读展示代理地址。

安装脚本增加 --proxy 参数，向已有插件条目合并代理配置；配置仍保存至 profile，重启后生效。升级时保留原始配置和回滚策略。测试覆盖代理规范化、全部请求端点、取消及资源释放、未配置时的网络策略保持、安装配置合并；本机代理实际连通性与账户登录需普通终端联调。

验证：59 个测试通过，无跳过；真实安装依赖测试实例化宿主 undici ProxyAgent，并确认其用于推理请求。OAuth / JWKS、刷新、模型、推理、撤销的 8 次请求共用同一代理代理对象；代理参数配置合并、重复运行及失败回滚通过测试。语法检查和 0.2.1 包生成通过。未验证 127.0.0.1:7890 的真实连通性；换令牌失败仍不能仅凭回调页面判断登录成功。

## 目标与范围

在独立 npm 插件 `dsh-llm-chatgpt` 中，通过 OpenAI 官方 Sign in with ChatGPT 开源客户端流程，将具备资格的 Plus / Pro 账户接入 DSH 的 LLM 接口。实现浏览器 OAuth、受保护的凭据存储、刷新、账户模型列表、SSE、文本及工具调用。DSH 继续负责执行工具和会话管理。

## 实施

- 原生 Node.js ESM，Node `^22.19.0 || >=24.0.0`，无编译步骤。运行时仅依赖宿主 DSH 的 llm 与 credentials 接口；authorization 服务提供登录交互。
- 插件命名 `llm-chatgpt`，默认 provider `chatgpt-plan`。不接管已有 `openai` / `openai-codex` 路由。
- 初次使用 `dynamic_agent_client`，稳定 host ID、PKCE S256、随机 state 和 nonce；回调仅监听 127.0.0.1。交换使用回调签发的 client ID。
- OIDC discovery / JWKS 验证 RS256 签名、issuer、audience、expiry、nonce、subject；验证订阅使用 scope。重新登录禁止更换已选账户身份或 client ID。
- 所有 grant 通过 `credentials.modifyRecord` 原子保存，刷新在该锁内完成。每个 provider 实例独立账户；host ID 共用。避免直接读写 Codex 凭据。
- POST `https://api.openai.com/v1/responses`，固定 `store:false` / `stream:true`；每次提交完整历史，system 转 instructions；函数工具置于 namespace 中。
- 解析文本、推理摘要和工具增量；必须收到终态才成功；保留 encrypted reasoning replay，用量区分缓存。
- 首版仅声明文本输入，图片等内容显式拒绝。temperature / maxTokens 不发送（订阅预览接口不支持），stop 非空拒绝。
- GET 官方 models 端点，只展示 visibility=list 的账户目录；不硬编码可用模型或额度。
- 本地 DSH 尚无通用授权交互入口，因此可选挂载 commands / userQuestions，注册 provider-login、provider-status、provider-logout 命令；登录链接通过用户问题展示，退出登录先远程撤销再清理 tokens，保留账户/client 映射。

## 影响与约束

仅写当前独立项目，不修改旁边 deepseek-harness。依赖接口以该本地源码（0.2.1-alpha.1）为基线。初版不自动安装、不修改用户 DSH profile、不默认切换模型、不发布 npm。

## DSH 0.2.1-alpha.1 适配

- 插件版本升至 0.1.1，peerDependencies 精确支持已核对的 DSH 0.2.1-alpha.1；不宣称旧接口或未验证的后续预发布兼容。
- 工具结果采用独立 `role: tool` 消息，使用消息顶层 `toolCallId` 生成 `function_call_output`。测试改为新消息格式，覆盖完整两轮工具往返、多工具结果及失败/空结果。
- 保留 system 指令转换与加密推理重放。不声明 toolUpdate 支持；由 DSH LlmRuntime 过滤 developer 工具变更消息并提供当前工具声明，直接传入未经投影的 developer 消息明确拒绝。
- 新版 base 已提供 authorization，安装示例只插入本插件；自定义 profile 缺失该服务时自行添加。
- 登录仍使用 credentials.modifyRecord 内的快照比较与取消检查。新版 session.commit(record) 无条件写入，无法原子比较当前凭据；嵌套调用还会重复获取同一存储锁。保留新版授权服务仍支持的直接写入路径，避免降低跨进程并发保护。测试取消提交、并发凭据变更拒绝、提交后授权服务识别成功。
- 重建安装包，保留旧 0.1.0 包，验证新包清单、Node 版本和示例内容。

真实宿主验证以当前源码加载为目标；依赖不可用时明确区分源码接口测试与完整 Cordis / LlmRuntime 启动测试，不将替身测试描述成完整宿主联调。

## 本次验证

- 本地 DSH revision：`5badb15009`，版本 `0.2.1-alpha.1`。
- `npm test`：37 个测试通过，无失败、无跳过。6 个测试直接执行当前 DSH 的消息构造、工具投影和 AuthorizationService 源码；基础 Cordis 与凭据后端为替身。
- 登录取消在开始前和提交前均拒绝写入；OAuth 期间其他写入修改凭据时，原子快照比较拒绝覆盖。并发刷新仍使用存储锁。
- 新版工具结果完整两轮往返、多结果关联、错误文本与空输出已验证。
- 尚未验证完整 Cordis / LlmRuntime 加载、生产凭据文件后端、真实 OAuth / 订阅调用。

## 本机安装

本机可执行命令 `/opt/homebrew/bin/dsh` 实际版本为 `0.2.0-rc.2`，用户选择 `web` profile。安装前增加该精确版本的兼容验证，不升级全局 DSH。使用本机安装产物的真实 Cordis、LlmRuntime、AuthorizationService 与 CredentialProvider 进行插件注册和工具结果请求测试，凭据使用内存后端、推理响应使用模拟数据。验证通过后插件升至 0.1.2，peer 范围仅列出 `0.2.0-rc.2 || 0.2.1-alpha.1`。

当前执行沙箱对 `/Users/wangzy/.dsh/profiles/web` 的写权限检查返回 EPERM，且不允许申请扩大文件权限。因此准备本机终端安装脚本，使用 `dsh plugin --profile web add` 安装本地包；脚本备份现有 profile 配置后合并插件项，避免重复插入，检查组合配置和模块导入。仅由用户在普通本机终端执行，不将沙箱内准备工作描述成已经安装。

## 安装验证修正

用户执行安装脚本后包 0.1.2 已安装，但 schema 全局验收触发了配置回滚。通过本机 app-boot 的只读 generateConfigSchema 对原有 profile 和新增插件配置分别检查，原有结果 complete=false，含两个 partial schema 和四个 Loader tree carrier 错误；加入插件后诊断没有增加，插件导入状态为 absent（未声明 Config schema，允许加载）。

安装器在写入前保存 schema 基线，安装后要求目标插件状态为 schema 或 absent，且没有新增 partial / unsupported / error 状态或诊断。非 JSON 输出、命令异常、目标插件导入失败、新增错误仍然失败。原有 schema 不完整但没有新增问题时明确报告，不声称整个 profile 的 schema 完整。加入纯逻辑回归测试与本机真实 profile schema 比较测试；不修改原有第三方插件。

修正后验证：45 个测试通过，无跳过；本机实际 profile 的基线与候选 schema 比较通过（complete=false，pluginStatus=absent），安装脚本和业务代码语法检查通过。测试 profile 验证了同版本包跳过安装、已有问题不触发误回滚、重复运行不重复插入、插件导入失败恢复原 patch。用户真实 profile 的启用步骤仍需在普通本机终端执行。

## ChatGPT 可视化管理页

- 插件升至 0.2.0，增加 DSH 浏览器 client 导出与 dsh.client 元数据，在 settings.section 插槽注册 ChatGPT 页面，出现在设置侧栏。
- 页面提供账户连接状态、浏览器登录按钮、取消、退出、模型目录刷新，以及当前 provider / callbackPort / requestTimeoutMs 只读信息。模型选择沿用 DSH 模型选择器，不擅自改变会话默认模型。配置字段仍通过 profile 编辑，页面不增加未验证的 settings 写入路径。
- UI 点击时同步打开空白窗口以避免 popup blocker，再调用本机管理 API 获取本地 OAuth 登录链接；回调完成后自动更新状态，不使用“已完成浏览器登录”的提问框。弹窗失败则提供可点击链接。登录期间轮询状态，停止或卸载后释放定时器；登录成功后显示订阅使用说明。
- Host 通过可选 webServer / webRuntime 服务注册管理 API，仅接受可信 Host、同源请求以及 index 注入的随机运行期管理令牌。管理令牌只在浏览器内存使用，与 OAuth 凭据分离；任何 API 不返回访问、刷新、ID token 或 PKCE 数据。变更端点只接受带授权标头的 POST；资产仍由 DSH client-modules 交付。
- 复用已有授权服务、OAuth 校验和凭据原子提交。卸载取消未完成登录并注销路由。注册多个 provider 时页面显示多路由；index 按 provider 收集各实例的 API 地址和管理令牌。
- 浏览器产物按已安装 DSH 的 __ModuleLoader__.load factory 协议交付，React 为宿主外部模块，不增加构建工具依赖。中英文文案通过 ctx.locale 注册。
- 验证 Host 管理状态机、授权及来源防护、取消与失败、凭据不泄漏；客户端模块注册、点击与 popup fallback、状态刷新与卸载；真实安装依赖加载和 npm 包客户端导出。无法使用浏览器自动化或访问真实账户时明确报告范围。

验证结果：53 个测试通过，无跳过。使用本机 DSH 真实核心服务验证了插件加载、管理路由注册以及 webserver 的 index 注入渲染；管理接口的来源检查与 capability 校验、取消、退出、公共状态脱敏通过测试。客户端 factory 在模拟模块加载器中验证 settings.section 注册、同点击栈开窗、自动状态更新、popup fallback 和释放轮询。语法检查和 0.2.0 npm 包产物检查通过。未获得真实浏览器 UI 截图或真实账户 OAuth 联调；web profile 的安装升级仍需普通终端执行安装脚本。

## 设置页视觉重构（0.2.4）

- 插件升至 0.2.4。浏览器页面不再使用内联样式对象，改为在 factory 内注入一张带 `data-plugin-css` 标识的样式表；样式全部落在宿主 `--dsw-*` 语义 token 上（宿主缺失 token 时回退到中性值），因此跟随浅色 / 深色主题与宿主换肤插件，不再出现与页面脱节的硬编码 `#111` / `#d33`。
- 结构按宿主设置页既有版式重组：模型路由以代码字体独立成行；账户卡片采用「状态点 + 身份行 + 状态标签」的人员行形态；操作区分为主操作与右对齐的退出；可用模型、当前配置各自成为带分隔线的区块，配置项由 `dl` 两列网格呈现，手动模型以 chip 标注。
- 状态表达补齐：加载、等待授权、已连接、未连接、代理失败各有对应视觉；未连接状态不再重复渲染同一句文案；模型列表显示数量；弹窗被拦截时保留可点击的登录链接；刷新模型期间按钮进入进度态并禁用。
- 文案仍为 zh / en 双语，新增 `refreshing`、`manual`、`disconnectedHint`、`pendingHint` 四个键，两侧键集合保持一致。

验证：`npm test` 71 个测试通过（含新增的客户端页面测试）；`DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test` 71 个测试通过、无跳过。客户端测试用模拟模块加载器渲染真实 factory，覆盖样式表注入与 token 契约、无内联样式、已连接 / 未连接 / 接口失败三种页面的文案与控件集合、登录开窗与 popup 回退。另用本机无头浏览器加载独立预览页截图核对浅色、深色、等待授权、未连接与代理失败五种状态，均无控制台异常；该预览不是 DSH 设置面板本身，真实 Web profile 中的显示仍需重启后人工确认。

## 提示缓存亲和与安装幂等（0.2.5）

插件升至 0.2.5；后续 0.2.6 增加官方 openai-codex 登录入口，0.2.7 修正该入口的 provider 卡片只应渲染在 openai-codex 行的问题。

订阅接口按请求体内的 `prompt_cache_key` 做缓存与路由亲和。插件此前不发送该字段，在 `chatgpt-plan` 路由上的表现是：用 `requestBody` 重放本机会话后确认相邻请求正文的公共前缀等于上一请求全长（前缀逐字节稳定），但间隔十几秒的连续请求仍整段未命中，命中量在 0 / 12k / 25k / 64k 之间跳变。同机同期其他路由命中率为 97–99%，该路由为 45.3%（22 步共 572,745 输入 token，命中 474,112）。官方客户端在同一路由每次请求都发送 `prompt_cache_key`，取值是 DSH 注入的 `options.sessionId`，并截断到 64 个字符。

`requestBody` 因此增加同名顶层字段：`sessionId` 存在且非空时发送其前 64 个字符（按码点截断），否则完全不发送该字段，不发送空 key。不发送 `prompt_cache_options` / `prompt_cache_retention`，与官方该路由保持一致。

安装脚本由"追加"改为"替换"。此前每次安装都向 `cordis.patch.yml` 追加一个 `- id: llm-chatgpt` 块（`--proxy` 与 `--model` 各追加一次），同一 id 出现多个条目；加载器按条目顺序把每一个都当作独立配置层叠加，同时配置里还被写入模板的 `# Merge these rows...` 手动安装说明。现在脚本删除该插件在任意嵌套深度已有的条目、清理因此变空的 `- insert:` 包装、丢弃模板注释行，再按 `examples/cordis.patch.yml` 的形状写入唯一一个条目，并继承上一次的 `proxyUrl` / `extraModels`（`extraModels` 按值去重累积）。重复运行结果逐字节稳定。

验证：`npm test` 75 个测试通过、1 个跳过（未设置 `DSH_INSTALL_ROOT` 的安装依赖测试），另用 `DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh` 单独跑通该集成测试，真实 `LlmRuntime` 转发的 `sessionId` 已断言落在 `prompt_cache_key` 上。安装脚本用用户真实 `cordis.patch.yml` 的副本演练：4 个重复条目合并为 1 个，原有内容与已设置的代理、手动模型全部保留。真实账户的缓存命中率回升仍需重新登录后实测。

## 验证与验收

使用 node:test 对真实 OAuth / JWT / wire / SSE / 刷新代码进行测试，模拟外部 OpenAI 返回值，验证错误、取消、截断和工具往返。通过 npm pack dry-run 检查交付内容。真实订阅资格、OAuth 服务开放、宿主实际加载及请求计费必须进行真实账户联调；未进行时明确标注，不将模拟测试作为接入成功。

## 归档：0.3.0 删除本文所述实现

本文记录的 `chatgpt-plan` provider——自建 OAuth、Responses 协议、SSE 转换、模型目录与订阅管理页——已在 0.3.0 整体删除。它存在的前提是 DSH 缺少官方 ChatGPT 订阅接入；该前提在 `@deepseek-ai/dsh-llm-pi-ai` 内置 `openai-codex` 后不再成立。

插件现为官方路由的设置页登录入口，范围与验证见 [方案 A 设计文档](design-task-openai-codex-in-plugin-login.md)。本文保留为历史记录，其中描述的模块、配置项与命令均已不存在，不作为当前行为依据。

## 依据

- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- 本地 DSH `packages/llm/llm/src/types.ts`、`packages/credentials/credentials/src/index.ts`、`packages/credentials/authorization/src/index.ts`
- 官方客户端缓存键实现：`@earendil-works/pi-ai` 的 `api/openai-codex-responses.js`、`api/openai-prompt-cache.js`
