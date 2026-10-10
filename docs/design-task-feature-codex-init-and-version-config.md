---
description: "新增 /init 项目规则初始化命令，并将 Codex 内置请求版本迁移到随包发布的独立配置文件。"
kind: "design"
---

# 项目规则初始化与 Codex 内置版本配置实施方案

## 状态与概要

状态：源码已实现，自动化验证记录见末尾；真实 GUI 验收未完成，未部署或发布。方案日期：2026-10-10。审查基线：插件 0.3.12、已安装 DSH 0.2.1-alpha.1；方案写入前工作区干净。

新增对话框 "/init" 命令，由当前会话 Agent 检查项目并生成当前工作目录下的 AGENTS.md。插件不启动外部 Codex CLI，也不写入固定规则模板。将内置 Codex 请求版本从 TypeScript 常量迁移到独立 JSON 配置，初始值为 0.162.1；修改配置无需重新编译，重启承载插件的 DSH 进程后生效。

设计章节保留实施契约，实际完成情况以末尾实施记录为准；功能尚未发布到既有 0.3.12 安装包。实施仅修改本仓库，未安装插件到现有 profile、重启服务或发布。

## 目录

- [目标与非目标](#目标与非目标)
- [已核实事实](#已核实事实)
- [init 命令行为](#init-命令行为)
- [初始化提示词](#初始化提示词)
- [版本配置](#版本配置)
- [改动范围与步骤](#改动范围与步骤)
- [验证与验收](#验证与验收)
- [风险与兼容性](#风险与兼容性)
- [实施记录](#实施记录)

## 目标与非目标

目标：

1. 用户输入 /init 后，当前 Agent 启动独立的项目规则初始化任务。
2. 规则内容基于项目实际事实；已有 AGENTS.md 不覆盖、不修改。
3. 规则生成复用宿主工具、sandbox、审批和规则加载机制。
4. 内置 Codex client_version 由随插件发布的配置文件控制，代码不保留第二份版本默认值。
5. 保留环境变量覆盖和本机 CLI 探测的现有优先级。

不在本次范围：

- 新增终端 dsh init 子命令、外部 Agent 或独立 Codex CLI 调用。
- 初始化全局规则、批量生成子目录规则、强制覆盖、合并已有规则。
- 升级系统 Codex CLI、宿主 pi-ai、OAuth 或推理协议。
- 新增版本设置 UI、Cordis 用户配置字段、文件监听或自动在线更新版本。
- 发布版本号、安装现有 profile、提交或 push Git；这些操作另行授权。

## 已核实事实

| 事实 | 依据与影响 |
| --- | --- |
| 插件通过可选 commands 注入注册 /usage | [入口](<../src/index.ts#L25-L37>)、[命令定义](<../src/usage-command.ts#L63-L65>)；新增命令沿用此模式。 |
| 当前结构接口只声明 rawInput 和 signal | [命令接口](<../src/usage-command.ts#L5-L9>)、[插件类型](<../src/types.ts#L21-L24>)；init 需新增含 agent 的接口，不能强迫 usage 使用 agent。 |
| 宿主实际向 handler 提供 agent、rawInput、attachments 和 signal | 已读取已安装 dsh-commands 的执行实现；命令回执不会自动变成模型消息，需显式投递任务。 |
| Agent 提供 followup 和 steer | 已读取已安装 dsh-agent 的 runtime-types；followup 排队独立回合并唤醒，steer 会进入运行中任务的最近步骤。本方案选 followup。 |
| Codex /init 提交初始化提示词 | [0.162.1 分发实现](<https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/chatwidget/slash_dispatch.rs>)；不是本地固定模板生成器。 |
| Codex 提示词要求检查当前目录，已有 AGENTS.md 不修改 | [0.162.1 提示词](<https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/assets/prompt_for_init_command.md>)；建议简洁文档，包含结构、命令、代码风格、测试、提交与安全要求。 |
| 审查基线内置版本为 0.160.1，当前配置已更新为 0.162.1 | [版本解析](<../src/host-catalog.ts>)保持环境变量、CLI、内置配置的顺序；当前值见[配置](<../config/codex.json>)。 |
| 插件不依赖 @openai/codex | [包配置](<../package.json>)；版本值只影响模型目录请求，见[请求实现](<../src/model-patches.ts#L116-L124>)。 |
| 本机 codex --version 返回 0.162.1 | 已执行；[npm latest](<https://registry.npmjs.org/@openai%2Fcodex/latest>)在审查时也返回 0.162.1，不代表协议兼容性已通过真实账号测试。 |
| 服务端构建采用 unbundle，产物目录为 lib | [构建配置](<../tsdown.config.ts#L3-L12>)；独立配置可保存在包根 config 目录，通过模块 URL 定位。 |
| 审查基线发布白名单没有 config，实施已补充 | [包配置](<../package.json#L30-L37>)；真实 tarball 验证配置已包含。 |
| 已安装宿主支持项目规则加载与工具操作后的刷新 | 已读取 dsh-agent-instructions 说明；不持续监听外部编辑，规则加载可被 profile 禁用。实现时需验证写工具后的实际刷新。 |

IDE MCP 未打开本仓库，审查采用源码读取。npm view 因默认缓存权限失败，未修改缓存权限；稳定版本通过 registry HTTP 查询核实。

## init 命令行为

### 注册与输入

- 名称 init，描述明确指出初始化项目 AGENTS.md、会调用当前模型且不修改已有文件。
- 无参数，不声明附件支持；非空 rawInput 返回用法错误，不投递消息。
- 注册与 usage 共用可选 commands 注入，缺少服务时不影响登录、额度或图片功能。
- 使用宿主作用域注册和卸载，不新增全局常驻状态或单独服务。

### 任务投递

1. 校验参数与 signal；已取消时不创建任务。
2. 检查当前 Agent 是否提供所需能力；不支持时返回明确错误，不降级为外部 CLI。
3. 完成 createUserMessage 的可选依赖加载等异步准备；缺少依赖时返回明确错误，不影响 usage 注册。
4. 所有异步准备完成后、投递前再次检查 signal 和命令作用域存活状态；已取消或作用域已卸载时不创建任务。复查与 followup 之间不得再插入 await。
5. 使用宿主 createUserMessage 创建 source.kind=user 的初始化消息，并调用 invocation.agent.followup(message)。消息中包含固定任务提示，不将其作为 system 指令。
6. 返回“已提交项目规则初始化任务；生成结果将在会话中展示”一类回执。

回执仅表示投递成功，不表示文件已创建。命令不等待 agent.whenIdle()：该方法等待整个 Agent 活动，不绑定本次消息，不能用于证明此次初始化完成。

运行中的 Agent 在后续独立回合执行初始化，不把任务 steer 到当前回合。投递前取消不产生任务；投递后任务由正常会话取消机制管理，命令 signal 的后续取消不自动等同于撤回已投递消息。命令作用域卸载时标记关闭并注销定义，在途异步准备完成后必须检查关闭状态，不得晚到投递；已经投递的任务不因插件卸载自动取消其它会话工作。验收时需验证真实 Web 命令入口能正常唤醒与显示该任务。

### 目标路径与已有文件

- 目标固定为当前会话文件系统工作目录下的 AGENTS.md，遵循 Codex 当前目录语义。
- 不自动向上查找 Git 根目录作为写入位置。子目录会话生成的是该子目录范围的规则；提示词和文档需明确此点。
- 不使用插件进程 process.cwd() 或本开发仓库路径。由当前 Agent 的工具解析目标工作目录。
- 目标已存在时停止，报告保留原文件；符号链接、目录、权限错误或存在性不明确时不得当作不存在。
- 不触碰全局规则、CLAUDE.md、其它目录规则或项目业务代码。
- 写入前再次检查目标，写入后读回验证；不允许额外执行安装、服务启动、测试全量运行或提交。

已安装 DSH 0.2.1-alpha.1 的 fs-observation-policy 对未观察或确认不存在的目标采用 createIfAbsent，本地 fs-local 使用原子 no-replace 发布：目标在检查后被其它调用者创建时，本次写入拒绝且保留对方文件。该结论限定于挂载这两个组件并通过宿主 write 工具执行的组合，不承诺所有 profile 或第三方文件系统。

初始化必须复用此路径。发现目标存在或收到创建冲突时立即停止，报告保留已有文件；不得读取冲突文件后改为覆盖，不得通过 edit、shell 重定向或其它写入路径绕过。底层原子创建保护不等于模型行为的绝对保证：模型若读取已有文件，其后 write 意图可能变为 replaceIfVersion，因此已有文件不改仍需提示词约束和真实会话验收。本次不另建写入工具。

## 初始化提示词

新增服务端专用提示词模块，参考 Codex 的内容组织而非逐字依赖上游资源。提示词在执行 /init 时才进入会话，不加入每轮系统上下文。

关键要求置于前部：当前目录目标、已有文件不改、仅生成规则、使用现有授权工具。生成流程：

1. 确认工作目录，检查目标文件并读取适用的上层或全局指导。
2. 有界读取目录、项目配置、README、测试和必要的近期 Git 历史，不扫描依赖、缓存或无关目录，不读取密钥。
3. 归纳项目结构、开发与构建命令、代码风格、测试方法、提交约定及安全要求。
4. 只记录已核实事实；没有覆盖率要求、PR 规范或架构信息时不凭空补齐。列出命令不等于已执行成功，不声称未运行的验证通过。
5. 生成简洁 Markdown，标题可沿用 Repository Guidelines；内容遵循项目语言约定。采用 Codex 200–400 words 的简洁目标，但不对中文机械套用英文单词计数。
6. 不复制完整全局规则；只写项目特有、可执行、长期有用的指导。
7. 写前复查目标，通过现有 write 工具创建；遇到存在或创建冲突立即停止，不得读取后覆盖重试或改用其它写入方式。仅在创建成功后读回确认并报告实际位置与结果。

当前处于 plan mode、只读 sandbox 或缺少写工具时不得绕过限制；说明受阻原因或按宿主审批流程处理，不能提前报告生成成功。

## 版本配置

### 文件格式与生命周期

拟新增包根配置文件 config/codex.json，随发布包独立分发：

```json
{
  "codexClientVersion": "0.162.1"
}
```

配置字段仅用于模型目录请求的 client_version，不代表模型版本、插件包版本或已安装 CLI 版本。

服务端模块通过相对 import.meta.url 的固定路径定位文件，不依据工作目录，不向上搜索，不读取远程配置，不接受任意配置路径。以当前 lib 平铺结构为基线使用 ../config/codex.json；实现后以构建及解包产物验证路径。

启动加载时有界读取、解析并校验一次；文件上限 4 KiB。要求 JSON 对象、唯一受支持字段 codexClientVersion、非空字符串、最长 64 字符，并复用现有版本格式规则。未知字段、缺失文件、JSON 错误或非法版本保存为显式配置错误，不静默回退到代码中的旧版本。

加载模块不得因配置错误抛出异常：将结果保存为有效版本或配置错误，由仅供模型目录版本选择使用的 getter 在调用时返回版本或抛出受控错误。移除模块级读取失败会抛错的 CODEX_CLIENT_VERSION 常量设计，更新[模型目录默认参数](<../src/model-patches.ts#L116>)、重导出和所有测试消费位置；配置不是独立公开包入口，不为保留内部常量而扩大失败范围。通用 loadHostCatalog 的目录读取和凭据刷新不得访问该 getter。配置仅进入服务端模块，不打入浏览器 bundle。

配置错误仅阻止依赖请求版本的远端模型目录预览与应用，不阻止插件导入、登录、usage、图片生成、init、读取当前模型或恢复原生目录。通过模型补丁管理接口返回受控的版本配置错误，并在服务端诊断中给出文件路径和修复后重启的方式；页面展示明确的修复提示，不返回原始 JSON 或底层异常。实现专用 reason（例如 version-config-invalid）时，同步更新 PatchReason、管理接口、客户端中英文错误映射及对应测试，不得丢入无法区分的网络错误。

### 版本选择优先级

1. DSH_CODEX_CLIENT_VERSION：合法环境变量覆盖，非法值保持显式报错。
2. codex --version：保持现有 1500 ms 超时、4096 bytes 输出上限及格式校验。
3. config/codex.json 中的 codexClientVersion：内置默认请求版本。

配置是第三层兜底，存在环境变量或可用 CLI 时，修改它不会改变实际请求版本。若需强制使用指定版本，继续使用已有环境变量；本次不新增强制配置项或改变优先级。预览继续显示实际选中值与 environment、codex-cli、builtin 来源；builtin 现在来自随包配置。

配置在启动时统一校验并保存结果，不影响其它功能加载。模型目录版本选择先检查该结果；即使环境变量或 CLI 可用，损坏的发布配置也返回配置错误，不继续出站。修复后重启以重新加载。有效配置下的版本优先级保持上述顺序。

### 更新与发布

- 仓库内更新默认版本：只改 JSON 的版本字段，不改 TypeScript 数字常量。
- 已安装插件更新：修改该插件实际安装目录内的配置后重启承载它的 DSH 进程，不需要重新编译，单独刷新浏览器不足以生效。
- 不提供自动编辑已安装配置的脚本；实际路径应通过插件安装状态确认，不硬编码用户目录。
- 插件升级或重装可能覆盖本地修改；长期固定版本建议使用环境变量。
- 将 config 加入 package.files；使用运行时文件读取，禁止 JSON 静态 import 被构建器内联成版本常量。
- 新发布包缺少配置属于打包错误，测试必须捕获；旧版插件尚不支持此配置，不对旧版安装目录添加 JSON 后承诺生效。

## 改动范围与步骤

以下为实施范围；文件已创建，实际选择与验证结果见末尾实施记录。

| 路径 | 工作 |
| --- | --- |
| src/init-command.ts（新增） | 参数、取消与 Agent 能力校验，独立回合消息投递，注册。 |
| src/init-prompt.ts（新增） | 服务端初始化提示词，明确目标与不覆盖约束。 |
| [src/index.ts](<../src/index.ts>) | 可选 commands 注入中注册 usage 和 init。 |
| [src/types.ts](<../src/types.ts>)及[usage-command.ts](<../src/usage-command.ts>) | 最小结构接口扩展；避免把 usage 专用接口当所有命令的通用接口。 |
| config/codex.json（新增） | 独立内置版本配置，初始 0.162.1。 |
| [src/host-catalog.ts](<../src/host-catalog.ts>)与 src/codex-config.ts（新增） | 配置有界加载、错误结果保存和模型目录专用 getter；保持版本优先级，通用目录与鉴权功能不依赖 getter。 |
| [src/model-patches.ts](<../src/model-patches.ts>)、[src/management.ts](<../src/management.ts>)、[src/client.ts](<../src/client.ts>)及对应测试 | 更新默认版本获取和重导出，增加配置错误分类与中英文修复提示，隔离错误影响。 |
| [package.json](<../package.json>) | config 发布白名单；仅在实际使用新的可选宿主包时补充精确 peer/dev 声明。 |
| [tsdown.config.ts](<../tsdown.config.ts>) | 核实模块输出与配置定位；仅在产物验证表明确有需要时修改。 |
| tests/init-command.test.ts、tests/installed-init-command.test.ts（新增） | 单元与真实 CommandRuntime 消息投递测试。 |
| [tests/plugin.test.ts](<../tests/plugin.test.ts>) | 注册集合按名称记录，覆盖两个命令与可选服务生命周期。 |
| [tests/host-catalog.test.ts](<../tests/host-catalog.test.ts>)及模型目录相关测试 | 配置、版本优先级、请求参数及已有回归。 |
| tests/codex-config.test.ts（新增） | 独立配置加载、错误隔离、版本优先级与重启验证。 |
| tests/packed-codex-config.test.ts（新增） | 对真实 tarball 解包验证配置完整性、模块路径及运行时读取；使用测试私有目录和子进程。 |
| [README.md](<../README.md>)、[docs/README.md](<README.md>) | 当前使用说明、配置生效条件、索引；实施后更新，不改冻结历史记录。 |

执行顺序：

1. 复核工作区与本方案，确认命令投递 API、会话行为和构建后模块布局。
2. 实现独立配置及加载校验、失败隔离与配置错误展示，更新版本测试与发布白名单。
3. 实现 init 提示词、命令和可选注册，补充作用域存活检查及冲突停止规则，更新类型及插件测试。
4. 验证宿主消息投递与文件工具写入、规则刷新；发现公开 API 缺口时先报告，不绕过宿主。
5. 完成必跑聚焦测试、类型检查、构建、解包和宿主集成，核对必测用例没有 skip；条件不足的检查明确记录为未完成。
6. 在获得运行环境修改授权后部署并完成真实 GUI 验收；再更新当前指南及本方案实施记录。

## 验证与验收

### 自动化

- 命令：发现、无参数、参数错误、附件拒绝、预先取消、投递异常、能力不支持、独立回合投递且每次有效调用只投递一次。用可控导入 Promise/barrier 固定“开始准备 → 取消或卸载 → 准备完成”的顺序，断言没有晚到消息，不能以 sleep 模拟。
- 生命周期：可选 commands 缺失不破坏其它功能；注册卸载后 init 和 usage 消失；Web 子作用域卸载不误销毁命令。
- 提示词：固定目标、已有文件保护、存在或创建冲突后停止且不读取覆盖重试、项目事实来源、读回验证和权限约束。文本断言只证明提示词内容，不冒充真实模型执行保证。
- 原子创建：在私有临时项目与真实 fs-observation-policy + fs-local + write 组合中，用 barrier 将另一调用者的创建安排在确认不存在与最终发布之间；断言本次写入拒绝，对方文件内容未变化，没有随后覆盖或 edit。记录所测宿主和文件系统组合。
- 宿主集成：CommandRuntime 的 command/run 和 command/done 配对，生成的 user message 来源与内容正确；真实 AgentLoop 或对应可控集成场景验证后续回合执行。
- 配置：合法值、非法版本格式、长度、未知字段、缺失、错误 JSON、超限、与当前工作目录无关的读取。缺失和非法配置下插件仍能导入、注册并使用其它功能；仅模型目录版本操作返回受控配置错误、不请求远端、不写模型设置，原生目录恢复仍可用。凭据与网络使用测试替身。
- 优先级：有效配置下环境变量免 CLI 探测、CLI 胜过配置、CLI 缺失或输出错误采用配置；请求 query 与预览值一致。非法配置即使有合法环境覆盖或 CLI 也拒绝模型目录版本操作，但不影响其它功能。
- 打包：正式 tarball 含 config/codex.json，解包后无需仓库文件即可导入和使用；改变解包配置并在新的 Node 进程重载后使用新值，证明未内联。
- 隔离：临时目录和配置使用测试专属副本；不修改已安装插件或仓库默认配置，不依赖真实网络、CLI 版本或进程全局环境的竞态。

以下为实施后的必跑检查，不是本轮已执行记录。新增测试文件名按本方案固定；若实现时调整名称，必须同时更新清单。使用[包脚本](<../package.json#L40-L44>)规定的类型检查、构建及 Node 运行方式。

```sh
npm run check
npm run build
node --disable-warning=ExperimentalWarning --experimental-strip-types --test tests/init-command.test.ts tests/codex-config.test.ts tests/plugin.test.ts tests/host-catalog.test.ts tests/model-patches.test.ts tests/management.test.ts tests/client.test.ts tests/usage.test.ts tests/usage-command.test.ts tests/image-service.test.ts
DSH_PACK_TEST=1 node --disable-warning=ExperimentalWarning --experimental-strip-types --test tests/packed-codex-config.test.ts
git diff --check
```

打包测试会执行 prepack 并重建 lib，因此默认在并行 npm test 中跳过，必须在其它构建与测试结束后以 DSH_PACK_TEST=1 单独运行；该跳过不能算打包验证通过。打包测试实际运行 npm pack，使用测试私有缓存和 pack 输出目录，等待 prepack 与 pack 成功退出；断言 tarball 含配置并解包，在独立 Node 进程中导入实际产物。只列出 package.files 或测试源码路径不算通过。修改解包配置后启动另一进程，断言其读取新值；不修改仓库或已安装插件配置。每次 subprocess 都设外层超时、确认非信号/超时退出，并等待清理完成。

宿主集成的命令模板如下，执行前把占位路径替换为实际核实的 DSH 安装根；缺少条件时不执行猜测路径：

```sh
DSH_INSTALL_ROOT="/absolute/path/to/installed/dsh" node --disable-warning=ExperimentalWarning --experimental-strip-types --test tests/installed-init-command.test.ts tests/installed-usage-command.test.ts tests/installed-host-catalog.test.ts tests/installed-model-patches.test.ts tests/installed-codex.test.ts tests/installed-image-tool.test.ts
```

宿主集成必须核对实际通过的用例和 skip 数量。相关必测用例被 skip 时，记录“宿主集成未完成”，不能因命令退出码为 0 宣称验证通过。新增 init 集成必须包含真实工具原子创建竞态场景，以及真实 AgentLoop 或可控集成场景的后续回合执行，不仅用 agent.followup spy。采用 barrier 和事件等待，避免真实网络、固定 sleep 和共享临时路径。

只有上述必跑检查通过、必测宿主用例未 skip，才标记“自动化验证完成”。真实 GUI 与会话验收单独记录；缺少授权或环境时标记“自动化验证完成，GUI 验收未完成”，不得标记整项验收通过。需要时再执行完整 npm test，不以扩大测试数量代替这些必要证据。

### 真实会话验收

| 场景 | 验收标准 |
| --- | --- |
| 无规则文件的临时项目 | /init 出现在命令发现中；回执仅说任务已提交；模型使用工具检查项目并创建符合事实的规则，读回后报告完成。 |
| 已有 AGENTS.md | 文件内容、摘要与修改时间保持不变；会话说明保留已有文件。 |
| 同时两个不同目录会话 | 各自仅针对其当前目录；不使用 DSH 进程启动目录。 |
| 子目录会话 | 写入子目录，不偷偷提升到仓库根；说明规则作用范围。 |
| 运行中任务 | init 成为后续独立回合，不混入当前任务。 |
| plan mode、只读或审批拒绝 | 不绕过权限；不写文件、不虚报成功。 |
| 取消与重复请求 | 正确区分未投递、已排队及运行中取消；准备期间取消或卸载后不晚到投递；重复执行不覆盖已生成文件。 |
| 并发创建冲突 | 当前宿主原子创建路径保留并发创建者的文件；Agent 遇到冲突停止，不读取后覆盖重试。 |
| 配置损坏 | 页面提示版本配置修复方式；远端模型目录操作失败，登录、usage、图片、init 和原生目录恢复不因配置错误失效。 |
| 规则加载 | 默认宿主下一次适当工具/请求边界能识别新增规则；禁用规则加载的 profile 不承诺生效。 |
| 配置修改 | 无环境覆盖且 CLI 探测不可用的受控场景，修改独立配置并重启后请求和预览采用新值；浏览器刷新不冒充服务端重载。 |

真实模型、账号和 GUI 验收需要实际执行；缺少授权或条件时保留未验证项，不用 mock 测试替代。

## 风险与兼容性

1. **已有文件保护**：已核实的观察策略与本地文件系统组合有原子 createIfAbsent 保护；其它组合需单独验证。模型读取已有文件后可能取得替换意图，因此必须在存在或创建冲突时停止，不能读取覆盖重试；不将底层保护宣称为模型工作流的绝对保证。
2. **任务完成判定**：命令注册结果与文件生成是两件事；命令回执不读取整个会话来推断任务成功，不以 whenIdle() 代替任务关联。
3. **宿主差异**：现有公开 API 基于已安装 0.2.1-alpha.1 核实。旧宿主应有能力检查和错误说明；没有验证前不扩大兼容承诺。
4. **规则刷新**：通过宿主工具写文件能参与既有观察机制；插件直接 fs 写入则未必触发刷新，因此不采用直写规则方案。
5. **可选依赖与在途任务**：createUserMessage 的服务端加载不得破坏 usage 或无命令宿主的插件加载。采用动态导入时，在最后一次 await 后复查取消与命令作用域关闭状态，再同步投递；准备期间卸载必须阻止晚到消息，已经投递的任务保持会话正常生命周期。
6. **配置损坏**：独立配置缺失或非法属于明确错误，不使用硬编码兜底。模块导入与其它功能保持可用，仅远端模型目录版本操作被拒绝；错误结果保留到进程重启，配置修复提示和错误隔离需要测试。
7. **版本语义**：0.162.1 仅是审查时确认的稳定请求标识，不保证账户权限、模型能力或宿主协议升级。已有可用 CLI 会胜过配置文件值。
8. **安装与升级**：本地改动配置在重装时可能丢失；不提供热更新，不自动执行全局 npm 安装或修改 profile。
9. **构建布局**：相对路径必须用源码、lib、tarball 三种场景验证；修改构建方式时需保留该测试。

## 实施记录

- 2026-10-10：完成代码审查与方案编写；尚未实现 /init 或独立版本配置。
- 2026-10-10：按方案审查结论修订：配置错误仅影响远端模型目录操作；补充宿主原子创建保护与冲突停止规则、异步准备后的取消/卸载复查，以及必跑测试与 skip 判定。修订仅涉及方案，功能仍待实施。

### 已实现

- [初始化命令](<../src/init-command.ts>)与[任务提示词](<../src/init-prompt.ts>)已接入可选 commands 注入；保持 usage 注册独立。使用 createUserMessage + followup，参数或附件拒绝、预先取消、异步准备后取消和卸载均有覆盖；命令回执不声称文件已生成。
- [版本配置](<../config/codex.json>)初始值 0.162.1，加入发布白名单；[配置加载模块](<../src/codex-config.ts>)使用有界运行时读取，保存有效版本或受控错误。版本选择维持环境变量 → CLI → 独立配置。
- 远端模型目录预览在读取凭据和刷新之前校验版本配置；配置错误不请求远端、不写模型设置。通用目录与鉴权模块不使用 getter，原生目录恢复路径独立可用。
- 管理接口使用 version-config-invalid 分类；服务端诊断包含配置路径，页面返回固定修复提示而非路径、原始 JSON 或底层异常。客户端中英文映射已更新。
- 已更新[当前使用说明](<../README.md>)、[未发布日志](<../CHANGELOG.md>)和[文档索引](<README.md>)。包版本仍为 0.3.12，不表示这次功能已进入已发布安装包。

### 已执行验证

| 操作 | 实际结果 |
| --- | --- |
| npm run check | 通过；包括新增服务端模块的严格 TypeScript 检查。 |
| npm run build | 通过；服务端 ESM 与客户端 IIFE 产物已生成，独立配置未内联。 |
| DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test | 176 个用例：175 通过、0 失败、1 跳过。唯一跳过是为避免共享 lib 重建竞态而要求独立执行的打包测试；所有宿主集成用例实际执行，无宿主 skip。 |
| DSH_PACK_TEST=1 node --disable-warning=ExperimentalWarning --experimental-strip-types --test tests/packed-codex-config.test.ts | 在完整套件结束后独立执行：1 通过、0 失败、0 跳过。真实 npm pack/prepack、文件清单、解包、新进程加载及坏配置隔离均通过。 |
| 指定安装根的聚焦宿主集成与客户端回归 | 35 通过、0 失败、0 跳过，包含新的真实 AgentLoop 初始化测试。 |
| git diff --check | 通过；新增文本另做空字节、尾随空白和 Markdown 代码围栏检查。 |

IDE MCP 编译接口因该项目未在 IDE 打开而不可用；验证采用项目自身 tsc 与 tsdown，不将 MCP 调用失败记作构建成功。

打包测试默认跳过但已单独补跑成功，因此本次必要自动化验证完成。打包产物、配置变更和缓存均使用测试私有临时目录，完成后清理；未修改现有安装目录或 profile。期间发现了打包 prepack 与并行测试共享构建产物的竞态，测试改为 DSH_PACK_TEST=1 独立执行，当前指南与必跑清单已同步。

### 宿主证据与限制

[宿主初始化集成](<../tests/installed-init-command.test.ts>)挂载真实 CommandRuntime、AgentLoop、ToolRuntime、fs-local、fs-observation-policy 和 agent-instructions，使用脚本化 LlmAdapter 而非真实模型：

- 原任务请求被 barrier 暂停时提交 init；未进入当前回合，释放后产生独立回合。
- 工作目录不同于 fs-local 默认目录；新规则写入会话目录，不写服务默认目录。另一会话写入不同目录。
- 再次执行保留已有规则；在临时文件发布前由另一调用者独占创建目标，当前写入拒绝，保留对方内容且没有覆盖重试。
- 新规则经工具写入后，在下一次模型请求中出现 agent-instructions 来源的内容，验证了已启用组件下的实际刷新。
- 命令日志配对与卸载后的发现移除通过；取消/卸载准备期间的无晚到投递由 barrier 单元测试验证。

[打包探针](<../tests/packed-config-probe.mjs>)在与项目无关的 cwd 导入解包模块，验证默认值；修改解包配置后启动新进程，使用新值而无需重新编译。非法和缺失配置均不阻断插件导入、命令注册、登录入口、额度未登录结果或其它模块加载；模型目录操作拒绝，原生目录预览独立可用。具体生成、用量请求和恢复写入路径同时由各自服务测试与模型补丁错误隔离测试覆盖，不将仅导入模块当作真实远端功能验收。

### 尚未完成

- 真实 GUI 命令发现、输入回执、配置错误提示的浏览器验证，以及真实模型自主生成规则与所有安全约束的遵守情况未验收。
- plan mode、只读或拒绝审批时的真实模型行为仍待会话验收；提示词断言与脚本化 provider 不替代此项。
- 未安装到现有 profile、重启运行中的 DSH、修改实际安装配置、测试真实账号模型目录请求或发布。当前 GUI 不会因本仓库构建而自动获得功能。
- 当前自动化证据来自 macOS、本机已安装 DSH 0.2.1-alpha.1；不承诺其它宿主或文件系统组合有相同原子保护。

状态为“源码已实现，必要自动化验证完成，GUI 与真实模型验收未完成”。后续部署或发布需单独授权。
