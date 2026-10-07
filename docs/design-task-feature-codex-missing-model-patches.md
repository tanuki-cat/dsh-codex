# openai-codex 缺失模型补丁实施方案

> 状态：**实施完成，完成判据已达成**。远端目录读取（插件代码路径 + DSH 存储的 OAuth 凭据）与 `gpt-6.1-sol` 的真实推理均已实测通过（2026-10-07）；剩余未验证项与实现偏差见文末「尚未验证或存在偏差」。

## 目标与边界

当前插件只提供 `openai-codex` 的登录界面，不拥有推理协议或模型注册；模型选择最终取决于宿主 `llm-pi-ai` 已解析的路由目录。为解决安装的 pi-ai 目录滞后造成的“模型实际上可用却无法选中”，插件增加一项**由用户确认的缺失模型补丁**：以从 `openai-codex` 获取的完整模型列表为基准，与当前适配器可选模型及用户配置比较，仅补足缺失条目，仍由宿主 pi-ai 处理 OAuth、凭据刷新和推理。

不解决旧版 pi-ai 不认识新协议、缺少能力实现、账号未授权或远端拒绝请求的问题；“在目录中出现”“能选中”“能推理”必须分别验证。首个验证对象为 `openai-codex/gpt-6.1-sol`，只有在权威列表实际包含该 ID 且账号允许调用时，才把它作为成功验收对象；否则记录来源差异，不伪造列表或宣称通过。

## 已确认的宿主事实与前置调查

- 本机安装的 `@earendil-works/pi-ai` 为 `0.87.1`；其 `openai-codex` 静态目录有 8 个模型，缺少 `gpt-6.1-sol`。这是**本机安装目录**，不是远端完整列表。
- `llm-pi-ai` 的 `discoverModels` 遇到已知 provider 时直接返回安装目录；其远端可列举协议只包括 `anthropic-messages`、`openai-completions`、`openai-responses`，**不包括** `openai-codex-responses`。因此不能把现有“从目录添加”或 `discoverModels(openai-codex)` 当作获取最新 Codex 模型的方式。
- 路由配置 `modelOverrides` 只允许修改安装目录中已有的 ID；显式 `models` 可声明新 ID，但它**替换整个路由目录**，不会自动与原目录取并集。显式模型中与安装目录同 ID 的条目仍继承未设置的安装目录字段。
- 设置服务的 `describe()` 提供当前值与 revision，`mutate(ns, ops, expectedRevision)` 支持有条件写入；`llm-pi-ai.providers` 为可动态更新字段。使用其受支持的设置写入路径，不直接编辑 profile 文件。

**开始编码前的阻断性调查**：优先验证 `https://chatgpt.com/backend-api/codex/models` 是否能以当前 `openai-codex` OAuth 账号进行只读模型列举，以及它的认证要求、请求参数、分页/过滤、响应格式、账号可见性、更新频率、错误语义和使用条款。这里的路径是待验证候选，**尚未证明接口稳定或响应完整**；不得从宿主现有 `discoverModels` 推断其行为，也不得复用普通 OpenAI API key。无法证明响应完整且可信时，不以它驱动补丁写入。

> **该调查已执行（2026-10-07）**：认证要求与响应格式已确认（`Authorization: Bearer` + `chatgpt-account-id`，`{ models: [...] }`，`visibility` 过滤）。仍未确认的是**分页/过滤语义与更新频率**——见文末第 5 项。

## 模型来源优先级与降级策略

1. **首选：Codex 账号的模型列表**。在服务端通过已授权的 `openai-codex` 凭据尝试读取 `/backend-api/codex/models`，验证账号归属、响应完整性及模型 ID；其成功且可信的结果才是计算“缺失模型”的基准。不能把未验证的端点、单页结果或错误响应当成完整目录。限制目标主机，不让客户端传入 URL；不记录或返回 OAuth 令牌。
2. **OpenAI 公共模型文档：辅助核验**。用 [OpenAI 模型文档](https://developers.openai.com/api/docs/models) 与具体模型页（如 [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)）交叉核对公开 ID 和能力信息。公共 API 的文档收录**不等于**当前 ChatGPT/Codex 账号有权使用，也不能代替账号模型列表，不能单凭文档自动新增模型。
3. **fallback：已安装的 pi-ai catalog**。远端列表不可用时仍用安装目录展示并保留原有模型；它可以提供已有 ID 的配置继承基础，**不能**证明目录无缺失，也不能作为最新完整列表来计算空差异。降级状态只允许查看现有模型和错误原因，禁用新增补丁；已应用的条目保持不变，不因远端暂时失败而删除。

若将来只能取得官方发布快照而非账号实时目录，必须另行确认其适用范围、版本和日期，并明确告知用户它无法证明账号权益；不得静默把快照提升为实时基准。

上游协议证据：[Codex ModelsClient](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs) 请求 `models?client_version=…` 并解析 `models` 数组；[模型响应类型](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs) 包含 `slug`、`visibility`、`supported_reasoning_levels`、`context_window` 等。现有本机接口无认证请求得到 HTTP 401，仅证明需要授权，不证明当前 OAuth 凭据能读取或 `gpt-6.1-sol` 确实列在结果中。

## 数据与差异计算

1. 来源层获取一份 `openai-codex` 完整列表（含来源标识、获取时间与必要的模型能力字段），进行格式校验、去重和有界处理。凭据只在服务端使用；不向客户端返回 access/refresh token，不缓存任何密钥。
2. 读取设置服务中 `llm-pi-ai` 的当前 resolved value、raw user section 与 revision，定位 `providers.openai-codex`。同时读取运行中该路由的可选模型，得到当前服务中的模型 ID 集合。若该路由尚未声明，则提示先通过宿主界面“从目录添加”，首版不代建路由。
3. 以**官方来源列表**为完整比较基准，计算 `missing = officialIds − currentSelectableIds`。当 `gpt-6.1-sol` 不在官方来源列表，或当前已可选时，分别显示“来源未收录”或“无需补丁”，不得强制添加。官方来源中每个缺失模型还需有足够准确的协议、端点和能力信息；信息不足时标记待核实而不猜测图片输入、上下文容量、推理等级等。
4. 构造待写配置时，若当前有显式 `models`，以其**原始条目**为基础保留全部字段与次序，末尾追加经校验的缺失模型；否则以当前已安装且可选的模型 ID 构造显式条目 `{ id }`，使这些 ID 继续继承宿主安装目录元数据，再追加缺失模型。不得使用仅含显示名的 `listModels` 结果反向重建并覆盖用户自定义的能力字段。
5. 展示预览：来源/获取时间、官方数、当前数、新增/已存在/无法补充数、将保留的旧模型、写入后的完整模型 ID 列表，以及“显式 `models` 会接管目录”的提示。官方列表是**比较基准**，不是将所有官方条目无条件写入；只添加缺失且能力信息经验证的条目，不删除本地模型或用户自定义条目。

## 写入与回退

- 服务端新增只读预览与显式确认操作，复用现有管理路由的 capability token、同源/Host 校验；仅接受插件内已知的 `openai-codex` 路由，不接收客户端任意模型配置或目标 URL。
- 确认时服务端重读配置和 revision，重新计算预览；若与用户确认的版本或来源列表指纹不一致，返回冲突并要求重新确认。以 `expectedRevision` 写入 `providers.openai-codex.models` 的精确路径，保留同一 provider 其他字段、其他 provider 和用户层既有配置；设置服务校验拒绝时如实反馈，不降级为覆盖文件。
- 写入后重读设置和运行时模型列表，核实目标与原有模型都可选。可支持手动回退，但必须记录**本次补丁新增的 ID、写前配置摘要和写后 revision**；仅当相关条目仍与插件写入值一致时删除插件新增项。其余情况只给出冲突及手工处理建议，避免删除用户后续修改。若要撤销由补丁创建的显式 `models`，还需确认用户未继续编辑该字段，才能恢复写前缺省状态。
- 官方来源暂时不可用、返回不完整、未授权或未知能力时不进行写入；已应用配置保留，不能因下一次来源读取失败自动移除模型。补丁不随登录或插件启动自动应用。

## 代码落点

- 新建 `src/model-patches.ts`：来源适配、校验、差异计算、配置合成、幂等与冲突处理。具体来源实现必须等“前置调查”完成后确定；禁止依赖未公开的 pi-ai 内部文件路径。
- 扩展 `src/types.ts` 与 `src/index.ts`：按实际宿主注入契约取得设置服务及当前模型枚举能力，保持登录路径可在相关服务不可用时独立运行。
- 扩展 `src/management.ts`：只读预览/确认/可选回退操作，使用已有安全检查；返回最小必要的模型元数据和可诊断错误。
- 扩展 `src/client.ts`：仅在 `openai-codex` 卡片展示补丁入口、来源和差异预览、明确确认与失败原因；登录与补丁操作分离。
- 更新 `README.md`：适用范围、来源性质、显式 `models` 的替换风险及回退说明。

## 验证与验收

1. **纯逻辑测试**：官方列表含/不含 `gpt-6.1-sol`、当前目录含/不含目标、配置已有显式模型及能力覆盖、其他 provider 不受影响、重复应用幂等、来源缺字段/分页不完整时拒写、同名条目冲突、revision 竞争与回退后用户修改。
2. **宿主集成测试**：使用真实设置服务和 `llm-pi-ai` 路由验证预览、条件写入、热更新、原有模型不丢失、`listModels('openai-codex')` 可列出新增条目；确认不存在 `UNKNOWN_MODEL`。分别覆盖尚无路由和设置不可写的安全失败。
3. **`gpt-6.1-sol` 实测**：先保存来源列表证据及其更新时间；核实其中存在该 ID，应用补丁后在模型选择器可选，并在已授权账号下执行实际请求，确认响应成功和所用模型。若官方列表或账号未提供该模型，报告未满足该条件，不把历史 HTTP 200 记录作为此次实测。
4. **项目检查**：`npm run check`、`npm test`；对实际浏览器执行预览、确认与回退的人工检查，核实无 token 暴露。提交前检查变更范围、工作区状态和 diff。

## 实施与验收记录

### 已实测通过（2026-10-07）

**1. 远端目录读取：插件自身代码路径 + DSH 存储凭据**

用仓库内构建产物 `lib/model-patches.js` 的 `fetchCodexCatalog` 直接读取 `~/.dsh/.credentials.yaml` 中 `llm-pi-ai/openai-codex` 记录的 access/accountId 发起请求，结果：

| 项目 | 结果 |
| --- | --- |
| HTTP 状态 | 200 |
| 远端条目 | 10 |
| `visibility: list` | 7（`gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`、`gpt-5.6-luna`） |
| `visibility: hide` | 3（`gpt-reserve`、`gpt-5.5`、`codex-auto-review`，按设计排除） |
| 目标收录 | `gpt-6.1-sol` **存在**（`input=[text,image]`、6 个等级） |
| 容量字段 | `context_window=272000`（模型窗口）与 `max_context_window=872000`（配置覆盖上限） |
| 能力字段不足而丢弃 | 0（10 条均有 `context_window`、`input_modalities` 与 `supported_reasoning_levels`） |
| 被省略等级 | 5 个模型各有 `ultra`（pi-ai `THINKING_LEVELS` 无此项，按设计省略并记录；`gpt-6-luna` / `gpt-5.6-luna` 为 5 个等级，不含 `ultra`） |

排除逻辑经复核：`parseRemoteCatalog` 先按 `visibility !== 'list'` 跳过 3 条，其余 7 条全部通过字段校验，因此「可服务 7 条」完全由可见性解释，没有因字段缺失而被静默丢弃的条目。

这证明**插件自身的解析路径**能够以 DSH 存储的 OAuth 凭据读取账号目录，不再只是 CLI 旁证。

**2. 账号归属**

| 凭据来源 | `chatgpt_account_id` | plan |
| --- | --- | --- |
| DSH 存储（`llm-pi-ai/openai-codex`） | `0419d69a…` | plus |
| Codex CLI（`~/.codex/auth.json`） | `0419d69a…` | plus |

两者为**同一账号**，因此此前「两个账号可能不同」的保留不成立。

**3. `gpt-6.1-sol` 实际推理**

从本机 DSH 会话日志解压后按事件核对：

| 项目 | 实测值 |
| --- | --- |
| 推理 API | `openai-codex-responses` |
| provider / model | `openai-codex` / `gpt-6.1-sol` |
| 成功 assistant 响应 | 37 条，37 个互不相同的 `responseId` |
| 覆盖轮次 | turn 9（18）、turn 10（14）、turn 11（5） |
| 结束原因 | `toolUse` ×34、`stop` ×3 |
| 时间窗 | 2026-10-07 01:39:25Z – 01:53:00Z |
| 上下文窗口 | 补丁写入 `contextWindow: 272000`，与来源的 `context_window` 一致 |

「可选中 + 实际推理」双重条件均达成。该路由在后续会话中亦正常使用（另一会话 `openai-codex/gpt-6-sol` 71 次）。

### 上下文容量取 `context_window`

实测确认该端点对每个条目同时返回两个容量字段，二者语义不同（依据 [openai_models.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs) 的字段注释与 [AWS Bedrock 模型卡](https://docs.aws.eu//bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html)）：

| 字段 | `gpt-6.1-sol` 实测值 | 语义 |
| --- | --- | --- |
| `context_window` | 272000 | 模型自身的窗口。Bedrock 的「Long-context rates apply … when input exceeds 272,000 tokens」说明它同时是长上下文计费的分界 |
| `max_context_window` | 872000 | 「配置覆盖允许达到的上限」（上游字段注释原文：*Maximum context window allowed for config overrides*） |

**决定：取 `context_window`，缺失时回退 `max_context_window`。** 与上游 `resolved_context_window()`（`context_window.or(max_context_window)`）一致；两个字段都没有的条目按「能力信息不足」丢弃，不猜测容量。

> **本节曾一度改为优先 `max_context_window`（方案 A），现已回退。** 当时的理由是 Bedrock 把 272,000 写成计费分界、而 DSH 没有 CLI 那样的 `model_context_window` 覆盖机制，担心压缩过早。回退的理由是更根本的一条：`max_context_window` 的语义是**覆盖上限**而非模型窗口，把它声明为窗口等于插件单方面放大一个用户没有选择的额度；`context_window` 才是模型自报的容量，也是上游解析的第一顺位。需要更大窗口时，显式配置 `contextWindow` 即可——那是用户在宿主设置页可见、可改的选择。

因此已写入显式 `contextWindow` 的条目仍**不会被改写**。当声明值低于来源给出的窗口时，预览以「声明的上下文小于来源给出的窗口: gpt-6.1-sol (128000 → 272000)」报告，供人工决定。

Bedrock 模型卡标注 **1M**（1,050,000），与 Codex OAuth 端点报的 272000/872000 都不同。二者很可能是不同产品面的差异（托管版 vs OAuth 路径），本插件以**端点自报值**为准，不采用文档数字。

### 已实现范围

账号模型目录只读预览、差异追加、revision 冲突校验、只读安装目录 fallback 及设置页确认；使用上游公开协议字段解析，未经验证的模型能力不写入。每个拒绝点携带稳定 reason 码，预览报告来源/时间/当前数/写后列表/接管提示/来源未收录/声明容量低于来源值，`apply` 返回写前摘要与写后 revision。`npm run check` 通过；`npm test` 在本机为 67 项（63 通过 / 4 跳过，跳过项需 `DSH_INSTALL_ROOT`），指定 `DSH_INSTALL_ROOT` 后为 **67 项全部通过**。

0.3.7 修复配置层显式空列表压过运行时目录的合并漏洞：写入基线现在是显式配置与运行时可选模型的并集，同 ID 保留显式配置；已增加空配置但运行时有目录的回归测试。实际 web profile 中被覆盖的 8 个静态目录模型已定点恢复，保留新增 `gpt-6.1-sol`，未改其他 provider。

### 遗留项与已闭合项

1. ~~**宿主集成测试不足**~~ → **已补**（`tests/installed-model-patches.test.ts`）。该测试挂载真实 `@deepseek-ai/dsh-llm` 与真实 `dsh-llm-pi-ai` 适配器，并且：
   - 写入前经**真实 `llm-pi-ai` `Config` schema** 校验，宿主拒绝的 section 到不了 profile；
   - 断言真实 `LlmRuntime.resolveModelInfo` 在补丁前对 `gpt-6.1-sol` 抛 `UNKNOWN_MODEL`、补丁后可解析，并保留负向对照（未知 ID 仍抛 `UNKNOWN_MODEL`）；
   - 断言写入保留目录模型与原顺序、保留 `contextWindow`/`input`/`reasoningEfforts`、省略宿主无法表示的 `ultra`；
   - 经 `loader/volatile-update` + 新快照身份验证**热更新**，并断言重复应用幂等。
   
   仍有取舍：settings 服务本身是替身（真实 `SettingsForms` 需要完整 Loader 与 profile-boot 链，不适合单元测试），所以「`configEditor.edit` 真正落盘到 `cordis.patch.yml`」这一段仍未在测试中覆盖。回归验证改用变异测试：禁用 0.3.7 的并集循环后，该测试按预期失败并复现「原有模型列表消失」。
2. ~~**否定路径无测试**~~ → **已补**。`tests/model-patches.test.ts` 新增三项：设置只读时在任何列举/写入前即拒绝、路由未声明时报告而非代建、凭据缺失/过期/无 accountId 时不发起远端请求。`installed-model-patches.test.ts` 另覆盖「宿主 schema 拒绝的 section」与「写入被拒时如实上报且不重试」。四项均经变异测试确认能被对应用例捕获。
3. ~~**预览字段未完全落地**~~ → **已补**。预览现在报告：来源 URL（不含查询参数与凭据）、`fetchedAt` 获取时间、`clientVersion` 请求版本、`current` 当前可选数、`alreadySelectable` 已可选集合、写入后的完整模型 ID 列表（`preserved + added` 在界面明示为「写入后列表」）、`replacesCatalog` 与「显式 `models` 会接管整个目录」提示，以及 `unlisted`——保留但不在来源列表中的模型单列一行。空态区分：`added` 为空且`alreadySelectable` 覆盖来源条目时为「没有可补充的模型」，来源不可读时走只读 fallback 并附原因。
4. ~~**回退记录未落盘**~~ → **已补**。`apply` 的结果现在携带 `applied`（本次新增 ID）、`before: { revision, models }`（写前摘要）与 `after: { revision, models }`（写后状态），并由卡片显示为「配置修订: N → N+1」。记录只随响应返回、不落盘、不含密钥；自动回退仍不在首版范围内，但人工回退所需的写前摘要已经可得。
5. ~~**接口稳定性未证**~~ → **已收窄并加固**。实测确认该端点返回**单页无分页**（无 `Link`/`cursor`/`next` 头，增加 `cursor` 参数仍返回同一 10 条），且省略 `client_version` 会得到 HTTP 400——该参数是请求契约的一部分，不是可选装饰。代码相应加固：响应顶层出现 `models` 以外的键（例如将来新增的分页字段）即拒读，不再把未知信封当作完整列表；超限、非 JSON、非 2xx 与传输失败分别给出可诊断错误。`clientVersion` 现由单一常量 `CODEX_CLIENT_VERSION` 导出并随预览返回，便于复核与更新。**仍未被证明的是服务端的更新频率与条目稳定性**——这需要跨时间采样，超出单次实现范围。
6. ~~**降级语义混淆**~~ → **已修**。每个拒绝点抛出带 `reason` 的 `PatchError`（共 10 个码：`settings-unavailable`/`settings-read-only`/`route-missing`/`sign-in-required`/`credential-expired`/`credential-incomplete`/`source-unavailable`/`config-unmergeable`/`conflict`/`registration-unconfirmed`），路由原样回传该码，卡片按码显示对应处置方式。另有一项行为改进随之而来：路由未声明与设置为只读等**本地**拒绝现在先于网络请求判定，不再为一次注定失败的补丁消耗请求。
7. ~~**浏览器人工检查的记录不完整**~~ → **已自动覆盖**。新增的 token 不泄漏用例驱动全部六个路由并检查每个响应体与 index 注入脚本，断言 access/refresh/签名三段哨兵均不出现（`accountId` 除外——它标识账号身份、本就在卡片上显示，已就其范围单独断言以防扩大）。变异测试确认：让 `status` 回传 access token 后该用例失败。**回退操作的浏览器实测仍未留存**——插件不提供自动回退，人工回退由宿主模型设置页承担。

**完成判据与达成情况**：

| 判据 | 状态 |
| --- | --- |
| 可信 Codex 列表能够作为完整比较基准 | **达成**——插件路径实测 HTTP 200 / 10 条，账号归属已确认 |
| 缺失模型只在用户确认后补入 | **达成**——预览无写入，写入需 64 位签名与 `expectedRevision`；用户已在设置页实际确认 |
| 原有模型与配置保持可用 | **达成**——9 个模型（原 8 + `gpt-6.1-sol`）在配置中，8 个静态目录模型已定点恢复 |
| `gpt-6.1-sol` 通过「可选中 + 实际推理」双重验证 | **达成**——37 条成功响应，`responseId` 互不相同 |
| 来源无法证明或能力信息不足时明确拒绝自动补丁 | **达成**——无凭据/过期/字段非法/超大响应均拒写，降级为只读 fallback |

五项完成判据均已达成。上节列出的 7 项为测试覆盖与实现完整度上的偏差，不影响完成判据，但应在后续版本处理（尤其第 1、2 项）。
