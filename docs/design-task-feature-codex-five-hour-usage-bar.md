# Codex 5 小时额度条实施方案

> 状态：dev.4 已打包、安装并在原 GUI 复核，当前环境可行验收已通过；117 项测试通过。完整正式发布矩阵仍有约 375px、VoiceOver 全流程及真实换账号等未覆盖项，不宣称这些项目通过。
> 下文保留实施方案，最新事实以末尾「实际实施记录」为准。
> 日期：2026-10-07。基线：插件 0.3.9 与本机已安装 DSH 的实际契约。
> 目标：在模型选择器左侧显示当前 Codex 账号的 5 小时额度使用情况，只扩展插件，不修改宿主、不接管推理协议。

## 概要

采用宿主现有的 `conversation.input.right` list 槽位渲染紧凑额度条；服务端通过已有管理接口的鉴权边界，复用 DSH 存储的 Codex OAuth 凭据查询官方客户端使用的 usage 端点。UI 订阅当前会话的模型目录，仅在明确选中 `openai-codex` 且账号归属可确认时查询和展示。

难点在真实接口可用性、窗口识别、凭据更新与账号隔离、请求合并和旧数据降级。实施前先验证真实账号端点；验证失败应保留明确降级，不以本地 token 数估算订阅额度。

## 目录

- [目标与非目标](#目标与非目标)
- [已验证事实与待验证项](#已验证事实与待验证项)
- [架构与改动范围](#架构与改动范围)
- [上游查询与数据解析](#上游查询与数据解析)
- [插件接口契约](#插件接口契约)
- [凭据和缓存生命周期](#凭据和缓存生命周期)
- [前端行为与视觉规格](#前端行为与视觉规格)
- [安全与兼容性](#安全与兼容性)
- [实施步骤](#实施步骤)
- [测试与验收](#测试与验收)
- [发布与回退](#发布与回退)
- [实际实施记录](#实际实施记录)

## 目标与非目标

### 目标

1. 在截图指定的模型选择器左侧显示 `Codex 5h`、使用条及“已用 N%”。
2. 悬浮或键盘聚焦可查看剩余额度、重置时间、最后更新时间和数据状态。
3. 查询失败、未登录、没有 5 小时窗口均有明确反馈，不阻塞输入、发送或模型切换。
4. 多会话、多标签页共享服务端账号级缓存，避免每次渲染触发远端请求。
5. 不向浏览器、日志、测试快照或文档暴露 OAuth token。

### 非目标

- 不实现 OAuth、推理协议、远端额度重置或付费 credits 操作。
- 不自动修改模型目录、默认模型、订阅套餐或现有 profile。
- 不展示本会话 token 消耗，不将 token 数换算成订阅额度。
- 不把 5 小时剩余视为“模型一定可调用”的保证；周额度、模型专属额度、权限和其他限制仍可能拒绝推理。
- 首版不同时展示周额度、额外模型额度和 credits，不增加配置面板或新依赖。
- 首版只支持确认属于当前 Web Host 的会话；远端 Host 会话不使用本机账号额度冒充远端账号额度。

## 已验证事实与待验证项

| 内容 | 已验证依据 | 对方案的影响 |
| --- | --- | --- |
| 插件已支持 slots | [前端注册](<../src/client.ts#L473-L486>)、[manifest](<../package.json#L15-L24>) | 可增加槽位组件，保留设置页入口 |
| 槽位顺序符合位置 | [宿主渲染](</opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js#L22354-L22357>)先渲染 right，再渲染 model | 无需替换模型选择器或操作 DOM |
| right 是会话级 list | [宿主声明](</opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js#L23143-L23149>) | 注册独立贡献，不占 single 槽位 |
| 当前模型目录可订阅 | [ModelDirectoryState](</opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/types/client/directory.d.ts#L13-L42>)、[宿主注入](</opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-model-selection/lib/client.js#L1879-L1897>) | 复用 modelDirectories，不解析模型按钮文字 |
| 已有安全管理入口 | [管理路由](<../src/management.ts#L165-L183>) | /usage 继承 capability、Host、Origin 检查和 no-store |
| 现有账号信息不是额度 | [JWT 读取](<../src/codex.ts#L33-L48>) | 必须查询独立数据来源 |
| 已有宿主凭据刷新适配 | [鉴权桥接](<../src/host-catalog.ts#L48-L74>) | 复用公开鉴权解析器与 DSH 凭据事务 |
| 官方客户端查询 usage | [上游请求与 URL](<https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs>) | 候选端点为 chatgpt.com/backend-api/wham/usage |
| 官方客户端解析窗口字段 | [上游映射](<https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client.rs>) | 按 used_percent、limit_window_seconds、reset_at 归一化 |

本机宿主链接用于复现审查位置，不是跨平台安装路径要求。上游 main 会变化，实施时应记录验证使用的 Codex commit 或版本。

### 实施前必须验证

- 当前账号以 DSH 保存的 access token 和账号 ID 查询 usage 是否返回成功 JSON，是否需要额外兼容请求头。
- 返回是否包含可明确识别的 18000 秒窗口；实际字段、空值、异常值和套餐差异。
- 当前宿主的会话归属 API、ModelSelection provider 字段及默认模型解析：current 为 null 时不猜路由。
- slots 的 inject/session 参数、模型目录 store 的订阅方式与卸载约定，必须用宿主公开契约实现。
- 本机会话与远端会话的判定方式；无法判定时不发账号额度查询。
- UI 实际位置、活动控件展开时的隐藏行为、窄屏换行、深浅主题、HMR 卸载。

真实账号查询结果见末尾实施记录。官方源码存在查询接口不等同于所有网络和账号可用；该端点不是稳定公开 API。

## 架构与改动范围

### 数据流

```text
当前会话模型目录 + Host 归属
  → CodexUsageBar（right 槽位）
  → 可见组件共享的 UsageController
  → GET /chatgpt-management/openai-codex/usage
  → CodexUsageService：凭据检查 / 缓存 / single-flight
  → GET https://chatgpt.com/backend-api/wham/usage
  → 严格解析 + 账号复核
  → 仅返回归一化额度、状态和更新时间
```

额度服务在插件生命周期内创建，不挂靠模型补丁服务的 settings/llm 注入。读取额度不要求模型设置可写；只有需要 OAuth 刷新时才要求凭据存储可写。

### 预计文件范围

下列新增路径是计划，不表示文件已创建。

| 文件 | 计划改动 |
| --- | --- |
| `src/usage.ts`（新增） | 上游请求、解析、错误分类、缓存、single-flight、失效和 dispose |
| `src/client-usage.ts`（新增） | 客户端额度 DTO 类型、请求控制器、轮询及组件工厂；由现有 IIFE 入口导入 |
| [客户端入口](<../src/client.ts>) | 额度样式、zh/en 文案、槽位注册、模型与 Host 归属注入、登录变更通知 |
| [管理路由](<../src/management.ts>) | 新增 /usage 分支与服务生命周期接入；保持既有路由兼容 |
| [插件入口](<../src/index.ts>) | 创建额度服务、注入刷新适配器、释放服务 |
| [类型定义](<../src/types.ts>) | 最小扩展服务与客户端契约，不将私有宿主字段写成公共假设 |
| [鉴权桥接](<../src/host-catalog.ts>) | 优先原样复用；只有必要时补充最小复用接口，不做无关重构 |
| [manifest](<../package.json>) | 为前端追加实际需要的模型选择/会话服务模块；实施验证后决定是否需要新增 client-store 注入 |
| [构建配置](<../tsdown.config.ts>) | 确认新模块被服务端 unbundle 和客户端 IIFE 正确包含，必要时补入口 |
| `tests/usage.test.ts`（新增） | 解析、凭据、请求边界、缓存和并发测试 |
| `tests/client-usage.test.ts`（新增） | 控制器、状态、可见性和晚到响应测试 |
| [客户端测试](<../tests/client.test.ts>)、[管理测试](<../tests/management.test.ts>) | 支持第二个注册槽位，验证鉴权与额度路由，保留登录回归 |
| [README](<../README.md>)、[CHANGELOG](<../CHANGELOG.md>) | 完成实现后补用户说明、限制和实际验证记录；本轮不改 |

复用宿主 React、主题 token、store 订阅和现有 ModuleLoader 协议。组件不读取私有 CSS 类名，不使用 MutationObserver 或 portal 强插到模型按钮旁。

## 上游查询与数据解析

### 请求

- 固定 HTTPS GET 端点：`https://chatgpt.com/backend-api/wham/usage`。
- 服务端添加 `Authorization: Bearer <access>`、`ChatGPT-Account-Id`、`Accept: application/json`。
- User-Agent/originator 等额外头仅在上游源码和最小实测支持时添加；不照抄浏览器 cookie、不伪造客户端能力、不启用 Reserve 或兑换 credits。
- 使用 DSH 进程现有 fetch/代理策略，不新建绕过代理的网络栈。
- 禁止重定向；查询预算 10 秒，响应体上限 256 KiB；必须限制实际读取字节数，不能只信 Content-Length。
- 总操作预算含凭据解析、刷新和查询，建议 25 秒；不执行不受预算限制的自动重试。
- 不允许页面提供 URL、token、accountId、provider 或任意请求头，避免越权与 SSRF。

### 解析规则

1. 顶层必须是对象，校验额度结构；未知字段忽略，缺失与畸形区分。
2. 首版只读取主 Codex rate_limit 的 primary_window/secondary_window，不把 additional_rate_limits 的模型专属额度当作主额度。
3. 精确选择 `limit_window_seconds === 18000` 的窗口。无匹配为 no-five-hour-window；多个匹配有歧义则 invalid-response，不按字段名字猜。
4. used_percent 必须为有限数字且处于 0–100；错误值拒绝，不靠 clamp 将畸形响应伪装成正常。UI 四舍五入展示，内部保留合法精度；剩余为 100 − used_percent。
5. reset_at 按 Unix 秒转为毫秒，并校验有限、可安全表示及可显示日期。缺失可显示“重置时间未知”；已过重置时间的非零旧窗口不宣称实时，应立即标记过期并有界重查。
6. upstream 的 allowed/limit_reached 仅接受布尔值，可用于提示“账号当前受限”；不用于计算 5 小时百分比，也不决定发送按钮是否可用。
7. 无额度窗口不表示无限额度；未知套餐不猜额度总量或次数，不据百分比推算剩余消息数。
8. 如 usage 返回 account_id，必须与查询身份相符；不相符则 account-changed 并清空数据。

后端返回的百分比是查询时账号快照，无法保证瞬时同步所有客户端使用。

## 插件接口契约

### 新增读取接口

`GET /chatgpt-management/openai-codex/usage`，沿用 `x-dsh-chatgpt-token` 与现有 Host/Origin 检查；所有响应 `Cache-Control: no-store`。首版不提供强制绕过 TTL 的查询参数，点击刷新也受服务端缓存和退避保护。

以下为待实现 DTO，不是上游原始响应。时间统一 Unix 毫秒。

```ts
type UsageReason =
  | 'sign-in-required' | 'credential-incomplete' | 'credential-expired'
  | 'refresh-unavailable' | 'refresh-failed' | 'permission-denied'
  | 'rate-limited' | 'network-error' | 'timeout' | 'invalid-response'
  | 'no-five-hour-window' | 'account-changed' | 'service-unavailable'

interface UsageData {
  usedPercent: number
  remainingPercent: number
  windowSeconds: 18000
  resetsAt?: number
  fetchedAt: number
  usageAllowed?: boolean
}

type UsageReply = {
  state: 'ready' | 'stale' | 'unavailable'
  accountScope?: string
  data?: UsageData
  reason?: UsageReason
  nextCheckAt: number
}
```

- ready：data 必须存在，不携带失败 reason。
- stale：仅在 timeout/network-error/rate-limited 等暂时失败时允许同账号仍在展示期限内的 data，reason 明示最新一次查询失败。身份、凭据、权限、窗口或结构校验失败立即清除 data，不展示历史额度。
- unavailable：不带 data，reason 必须存在；不能构造 0%。
- accountScope 是本服务生成的随机不透明标识，供客户端隔离展示；不是账号 ID、token、token 哈希或认证凭据。
- nextCheckAt 是服务端建议的最早再次检查时间，包含 TTL/退避；客户端仍需自己的最小间隔。
- 业务不可用使用 HTTP 200 的结构化状态；错误 capability/Origin/Host 返回既有 403，错误 method 返回 405。服务已关闭或未创建返回 503 固定安全错误，不返回异常原文。
- upstream 401 归为 credential-expired/sign-in-required，403 为 permission-denied，429 为 rate-limited，5xx 为 network-error；本地接口 403 不能被误解为 Codex 账号 403。
- 已知或临近过期凭据在查询前刷新；已刷新仍被 401 拒绝时不循环刷新，提示重新登录。有效期看似正常却收到 401，首版也不无限尝试强制刷新。
- 账号信息只保留必要的 opaque scope；不额外返回邮箱、JWT 声明、upstream body 或敏感诊断。

## 凭据和缓存生命周期

### 凭据使用

1. 每次 /usage 进入缓存判断前重新读取 CODEX_KEY，校验 grant/access、到期时间和 accountId。身份缺失时拒绝查询。
2. access 有效且有效期超过五分钟可直接使用；缺少 refresh token 不应妨碍尚有效的 access 查询。
3. 需要刷新时复用现有 pi-ai 公开 getAuth 与 DSH modifyRecord；没有宿主刷新能力、refresh token 或可写 store 则给出明确原因。
4. 刷新结束重新读取凭据和账号，不使用刷新前 access。额度读取可能更新凭据，但不写模型设置。
5. 不自建第二份凭据 store，不读取 Codex CLI auth 文件，不从浏览器取 ChatGPT cookie。

### 服务端策略

| 项目 | 首版默认 |
| --- | --- |
| 成功 TTL | 60 秒；不得跨越已知 resetsAt |
| 旧数据最大展示期限 | fetchedAt 后 5 分钟，且不能跨越已知 resetsAt |
| 短暂网络失败退避 | 60、120、240、300 秒上限；成功后重置 |
| 429 | Retry-After 合法时遵循，最低 60 秒；无效时用指数退避；超过客户端 timer 范围时分段等待，不提前请求 |
| 身份/权限/结构不可用 | 至少 300 秒负缓存；凭据变化立即解除旧账号负缓存 |
| 刷新失败 | 至少 300 秒负缓存，防止多标签页持续触发令牌交换 |
| 合并请求 | 同插件实例、同身份只允许一个远端请求，包括刷新阶段 |
| 缓存持久化 | 仅内存，不落盘，不写 localStorage |

实现可只保留当前账号的一份状态，不建立无限增长 Map。缓存 key 至少隔离插件/Host 实例与 accountId；内部凭据指纹仅在内存计算，不记录或返回。

### 竞态保护

- 服务维护 credential generation。账号或外部凭据内容变化、登录开始、退出登录、服务 dispose 均失效缓存、递增 generation 并取消在途请求。
- 插件自身受控刷新可以保留同账号 scope，但刷新前请求不得继续提交；刷新结束后用新凭据开始查询。
- upstream 响应提交前复核当前记录/账号与 generation。发生变化立即丢弃响应，不能回写缓存或返回旧 data。
- 登录开始先清旧额度，登录成功重新读取；登录取消也重新确认凭据，不能自动恢复未经身份检查的旧缓存。
- logout 的失效在凭据删除前执行，清理失败也不能让旧请求回写；成功或失败随后重新确认真实凭据状态。
- 同页面登录组件通知额度控制器立即失效；其他标签页或外部工具的凭据变化在下一次检查发现，不承诺跨标签页瞬时推送。
- 客户端每次请求都有 sequence；路由/Host 切换、登录变更、卸载时递增并 abort。旧响应即使成功也不能重绘。
- 可取消请求不等于凭据刷新事务可以回滚；已有写入以重新读取的当前状态为准。

## 前端行为与视觉规格

### 显示条件

- 注册 conversation.input.right list 项，使用独立贡献 id（list 必需字段，不是 keyed 的 key），不改变 conversation.input.model。
- 从 modelDirectories.directoryFor(sessionId).store 读取已确认的 current.provider；current 为 null、provider 未知、子代理不可用或 Host 归属不明时隐藏且不查询。
- current 明确为 openai-codex 后显示；切换其他 provider 立即停止轮询。模型切换待提交期间保留已确认路由，不用 pending 值冒充已保存选择。
- 远端会话在首版隐藏；除非已有公开路由能同时保证远端 endpoint、capability 和身份对应，否则不做本地查询兜底。
- 宿主活动控件展开会隐藏 standardControls；额度条跟随宿主，不强行保持显示。存在其他 right 槽位贡献时不覆盖它们；实施时确认公开排序能力，有能力则让额度项尽量靠近模型，否则接受 right 区域内原生顺序。

### 正常状态

```text
Codex 5h  [━━━━░░░░]  已用 42%    GPT-6.1-Sol Medium ▾
```

- 整体高度约 28px；常规总宽控制在约 120–150px，轨道约 48px，高约 4px；以真实布局验收调整，不强制扩大输入栏。
- 填充代表已用，文案明确“已用”；80% 起警告，95% 起危险，0%/100% 正确显示。优先使用宿主主题 token，颜色不是唯一状态表达。
- 悬浮和键盘聚焦显示：账号共享 5 小时额度、已用/剩余、预计重置时间、最后更新时间；说明不含周额度/其他限制。
- 重置时间用浏览器时区格式化，不能硬编码 Asia/Shanghai；日期未知时明示未知。
- 数据超过 TTL 或最新查询失败则样式弱化，并显示“旧数据/更新失败”。超过 5 分钟或重置时间后去掉数值和填充，显示未知，不模拟额度自动归零。

### 状态表

| 状态 | 简短显示 | 行为 |
| --- | --- | --- |
| 首次请求 | Codex 5h + 静态占位 | 不显示百分比，避免加载动画持续干扰 |
| 正常 | 已用 N% + 使用条 | tooltip 显示详细信息 |
| 同账号刷新中 | 保留仍有效数据 | 不闪回占位，标明更新时间 |
| 可保留旧数据的失败 | 已用 N% + 旧数据标记 | tooltip 给出原因和更新时间 |
| 未登录/需重新登录 | Codex 未登录/需登录 | 提示到设置 → 模型登录，不自动弹 OAuth |
| 没有 5 小时窗口 | Codex 5h — | tooltip “账号未返回 5 小时额度” |
| 权限/限流/网络/畸形数据 | Codex 5h — | tooltip 展示固定本地化原因和重试建议 |
| 接口 capability 失效 | Codex 5h — | 提示重新加载页面；不循环高速请求 |

首版不要求新增设置页导航 API。额度区域可点击或键盘激活请求刷新；实际最早查询仍受 TTL/nextCheckAt 约束，冷却期间清楚提示，不能旁路服务端限流。

### 轮询与卸载

- 首次符合显示条件立即检查；成功后按 nextCheckAt、客户端最小 60 秒间隔和可见性调度。
- 同标签页同 endpoint/capability 使用一份控制器，按可见订阅计数运行；最后一个订阅卸载即停止并取消请求。
- document.hidden 或离线时停定时查询，隐藏不卸载现有数据；恢复可见、focus、online 事件按 freshness 和 single-flight 去重，不各自发起请求。
- 无凭据/权限失败仍按负缓存低频检查，以发现另一标签页的新登录；同页面登录成功可立即触发身份检查，但不无条件绕过 upstream 退避。
- UI useEffect 清理、插件 effect disposer 和 HMR 均释放 listener、timer、模型 store 订阅及 fetch；无 setInterval 重叠请求。
- 采用宿主 React 的安全快照订阅方式；当前测试 double 未完整覆盖 effect cleanup，新增测试必须真实模拟依赖变化和卸载，不能仅验证初次渲染。

### 无障碍与响应式

- 有效数据使用 role=progressbar，aria-valuemin=0、aria-valuemax=100、aria-valuenow 与 aria-valuetext 明确“5 小时已用”。未知状态不暴露虚假的 aria-valuenow。
- 可操作容器支持 Tab、Enter/Space、可见 focus ring；不要在 button 内嵌另一个 button。
- tooltip 必须支持键盘，不能只用 title 承载全部信息；错误不每分钟通过 alert 打断读屏。
- 窄屏缩成“5h + 短条 + N%”，更窄时去掉轨道保留 5h/N%；最低宽度仍不足则允许宿主原生换行，不通过负 margin 覆盖模型或发送按钮。
- 使用 zh/en 两套文案与宿主字体、主题颜色；尊重 prefers-reduced-motion。

## 安全与兼容性

- /usage 复用既有管理鉴权；这只是沿用当前本机 Web 安全边界，不新增用户认证保证。
- upstream 错误 body、Authorization、refresh token、账号 ID、内部凭据指纹不得进入页面或常规日志。诊断只记录固定 reason、HTTP status、耗时，不记录整个响应。
- 日志不得引用可能包含敏感内容的异常 message；测试用假 token，真实账号 probe 不打印 token 或完整账号响应。
- 缺少 slots、modelDirectories、会话归属公开能力时只禁用额度条，设置页登录功能继续工作；通过可选注入隔离，不把整个客户端启动绑到新服务。
- 不承诺所有 DSH 历史版本支持新槽位。发布时记录最低实测宿主版本，而不是根据包名猜支持范围。
- 不修改官方 pi-ai 包、不依赖私有导出或注入 fetch 拦截推理响应；上游响应头只能作为未来可选优化，首版唯一来源为 usage 查询。
- 不因为周额度耗尽关闭发送按钮；usage 是提示信息，最终可用性由宿主推理结果决定。

## 实施步骤

### 1. 最小真实数据验证（进入 UI 实施的前置条件）

1. 确认正在运行的 Host 与插件安装位置，记录宿主/pi-ai/Codex 上游版本。
2. 使用服务端现有凭据服务做一次 GET 验证；令牌只在服务内部读取和用于鉴权，不直接打开凭据文件、不打印 secrets，不触发推理或兑换操作。
3. 仅记录状态码、成功/失败类别、18000 秒窗口是否存在和字段类型；需要 fixture 时手工生成脱敏结构。
4. 若字段/端点不符，更新本待实施方案；若权限/网络不可用，报告具体失败，不声称端到端成功。解析器可继续用官方契约实现，但必须保留真实验收缺口。

### 2. 服务端额度服务

实现请求/解析纯函数、归一化 DTO、错误分类、账号级缓存和 single-flight；注入 fetch、时钟和刷新器便于确定性测试。接入管理 /usage，连接登录/退出/生命周期失效，先完成服务端测试。

### 3. 前端控制器与槽位

新增共享控制器、模型目录/Host 条件订阅、可见性调度、sequence 与 dispose。注册 right 槽位，补类型、manifest、样式与 zh/en；保留原设置页所有行为。客户端响应同样做轻量 DTO 校验，不将未知 JSON 直接断言为可信数据。

### 4. 验证与安装验收

局部测试通过后做完整插件回归、发布包 smoke；在用户确认的本机安装目标上更新插件，再验证原有 Web URL。检查深浅主题、窄屏、模型切换、账号退出与恢复、隐藏页面及 Host 切换。

### 5. 完成记录

更新 README/CHANGELOG 与本文件的实际结果，列出未完成项和最低实测宿主版本。真实额度验收未完成时不得标记整项完成。版本号在发布阶段决定，方案不预先承诺发布日期。

## 测试与验收

### 自动测试矩阵

| 类别 | 必测内容 |
| --- | --- |
| 窗口解析 | primary/secondary 的 18000 秒匹配；无窗口、null、重复匹配、错误类型、非有限值、负数、超 100、reset 秒/毫秒转换、已过重置时间、额外模型窗口不混入 |
| 凭据 | 有效 access、有效 access 无 refresh、临近/已过期、刷新能力缺失、刷新失败、401 不循环刷新、记录缺失/不完整、账号变更 |
| 网络 | 10 秒取消、整体预算、重定向拒绝、body 读取上限、非 JSON、403/429/5xx、Retry-After 秒数/日期/异常值 |
| 缓存 | 60 秒边界、跨 reset 失效、5 分钟旧数据期限、负缓存、退避重置、每次命中前身份检查 |
| 并发 | 多请求一次 upstream/刷新；登录与退出中途失效；外部账号替换；同账号凭据替换；刷新完成晚到、dispose 后不可回写；旧请求 finally 不清除新请求 |
| 管理接口 | capability/Origin/Host 检查、method、no-store、ready/stale/unavailable shape、无 secrets、既有管理操作不回归 |
| 客户端 | provider/Host 判定、current=null、pending 切换、未知 DTO、共享订阅、隐藏/离线/恢复事件、TTL 冷却、手工刷新、abort、旧 response、卸载/HMR、未知状态不画 0% |
| 渲染 | 槽位注册与模型订阅、0/100% aria、旧数据和错误文案、zh/en、有效进度值一致、键盘刷新 |
| 构建/宿主 | IIFE factory 协议保持；服务器新模块包含在发布包；真实宿主公开 API 与槽位契约匹配 |

测试使用可控时钟、fake timers 和 deferred promises，不依赖 sleep、真实网络、固定端口或进程全局时钟修改。新的客户端模块优先独立测试；对现有 browser double 只做支持新增注册与必要 cleanup 的最小调整。

### 计划执行命令

以下是实施后计划执行的命令。类型检查、构建、测试及打包本轮未执行；本轮仅执行 git diff --check 和新增文档的空白/空字符检查并通过，不代表功能验证通过：

```sh
npm run check
npm run build
node --disable-warning=ExperimentalWarning --experimental-strip-types --test tests/usage.test.ts tests/client-usage.test.ts tests/management.test.ts tests/client.test.ts
DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test
npm pack --cache .npm-cache
git diff --check
```

DSH_INSTALL_ROOT 使用验证机真实安装目录。新增测试路径需实施后才存在；按项目现有发布包入口 smoke 流程补验收。IDE 当前未打开本插件项目；若实施时仍不可用，记录事实并使用项目 check/build，不把无关 IDE 项目构建当验证。

### 手工验收标准

1. 普通本机会话选择 openai-codex 时，额度组件位于模型左侧且不覆盖其他控件；其他 provider、未解析路由、远端会话不查询本机账号。
2. 真实账号 GET 成功，UI 百分比与同次脱敏返回一致；明确显示 5h 和已用含义，不将凭据到期时间当重置时间。
3. 0%、100%、未知窗口、401、403、429、网络断开、畸形响应均按方案展示，输入和发送不受影响。
4. 同账号 transient 失败只在期限内保留旧数据，超过期限或 resetsAt 去掉数值；不能自动补成 0%。
5. 同账号多个会话/标签页在 TTL 内至多一次实际 upstream 查询；切换/卸载无继续运行的组件轮询。
6. 退出登录或换账号后旧数据立即在本页失效；晚到响应不可回写；跨标签页变化在下次检查发现。
7. 深浅主题、桌面常规宽度、约 375px 窄屏、活动控件展开、键盘与读屏语义验收通过。
8. 发布包使用宿主 React，设置页登录、取消、退出、模型补丁和恢复原生目录保持可用。
9. 使用原有 Web GUI URL 刷新验证安装后的产物；不启动替代服务器冒充更新完成。

## 发布与回退

- 本方案只要求插件构建，不要求重建 DSH Web shell，因为不修改宿主。客户端 HMR 只有实际 watcher 重建并由当前 Host 接收时才有效，不承诺源码保存即自动更新。
- 当前完整测试基线及发布包需保留；更新本机 profile 前说明安装目标并备份现有配置，发布/push 另行获得用户确认。
- 回退方式为安装前一个已验证插件包，必要时按宿主要求重启并刷新原 URL；额度缓存仅内存，回退不需清模型配置或修改凭据。
- upstream schema 改变时安全降级为未知额度；若需调整窗口/身份解释，新增后续方案并交叉链接，不改写已经冻结的完成记录。

## 完成判定

只有服务端/客户端测试、发布包检查、真实账号额度与原 Web GUI 验收均达到上述要求，才将本文件标记实施完成。当前核心展示与键盘详情已在原 GUI 通过，剩余兼容性验收项仍保留为进行中。

## 实际实施记录

### 已实现

- [服务端](<../src/usage.ts>)、[客户端控制器与视图](<../src/client-usage.ts>)及入口/管理路由已经接入；不修改宿主推理协议。
- 服务端按 18000 秒识别窗口，固定 HTTPS 端点、禁用重定向、实际读取上限 256 KiB；upstream 10 秒预算，总操作 25 秒，客户端 30 秒取消。
- 成功 TTL 60 秒、账号隔离与请求合并、认证暂停与 generation、暂时失败退避；旧数据不跨五分钟或重置时间。客户端包含 visibility/offline 调度、共享订阅及卸载取消。
- right list 槽位、provider/loopback/subagent 判定、已用百分比、可聚焦详情、zh/en、响应式 CSS 和进度语义均有实现或自动测试；不等同于完成真实屏幕验收。
- 开发版 `0.3.10-dev.1`；无新增 npm 运行时依赖。manifest 追加宿主模型选择、会话、连接模块依赖。未发布 npm、未提交或推送 Git；保留原工作区文档改动。

### 已执行验证

| 检查 | 实际结果 |
| --- | --- |
| `npm run check`、`npm run build` | 通过；服务端包含 usage 模块，客户端保持 IIFE factory |
| 定向额度/客户端/管理测试 | 55 项通过，0 跳过 |
| `DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test` | 113 项通过，0 失败，0 跳过 |
| `npm pack --cache .npm-cache` 及 tar 文件列表 | 通过；包含服务端 usage、浏览器 bundle、声明文件及用户文档，不包含测试凭据或临时 probe |
| `git diff --check` | 通过 |
| 最终构建真实账号 probe | `ready`、`windowSeconds:18000`、已用 61%、存在重置时间；连续两次读取 scope/fetchedAt 一致、缓存命中。数值仅为验证时快照 |
| 安装器及已安装 manifest | 开发包安装到 web profile；组合配置和插件导入检查通过，manifest 版本为 `0.3.10-dev.1` |

测试使用 fake clock、可注入 timeout signal 和 deferred promise，未使用 sleep 或全局时钟替换。覆盖解析、响应上限、HTTP 分类、缓存、身份竞态、刷新、操作取消、登录暂停、卸载和路由注册。IDE 未打开此插件项目，IDE build 不可用；使用插件自身 check/build 验证，没有构建无关项目。Node 的 EnvHttpProxyAgent experimental warning 不影响退出码或测试结果。

真实 probe 通过宿主 LocalCredentialProvider 和服务公开生命周期读取凭据，再调用最终编译的 UsageService；未打印 access/refresh token、账号 ID、原始 upstream body，没有退出或切换真实账号。

### 安装和当前 GUI 状态

安装已经用户权限审批，执行既有 [本地安装器](<../scripts/install-local.ts>)；安装器备份目录为 [配置备份](</Users/wangzy/.dsh/profiles/web/.chatgpt-install-backups/2026-10-07T05-09-52-358Z/>)。安装过程提示原 profile schema 导出仍不完整，本插件没有新增 schema 诊断；pnpm 提示存在 peer dependency issues。实际安装导入检查成功，不将这些提示声称为完全无诊断。

验证环境的 CLI 和 GUI 均显示 DSH `0.2.1-alpha.1`；本记录不宣布最低 GUI 兼容版本。未启动替代服务器，目标仍为现有 `http://127.0.0.1:3080`。

原 GUI 的模型菜单确认当前 provider 是 `openai-codex`、模型为 GPT-6.1-Sol。通过原窗口的「View → 重新加载界面」执行刷新后，输入栏仍没有可确认的额度条。因此只能确认安装文件更新，不能确认当前 Host 已加载新运行时模块，也不能将自动渲染测试当作真实 UI 成功。

安装器明确提示重启 dsh web。尚未重启承载本会话的 Host，以免中断任务；尚未确认新的 client HMR watcher。下一步需在重启原 Host 并刷新原 URL 后继续检查运行时加载与槽位。若仍无组件，应从 client module 注入、loopback 判定、ModelDirectory current 和浏览器加载错误定位，不能用放宽账号归属或 DOM 插入绕过。

### 后续边界修正与当前安装版

`0.3.10-dev.2` 修复可见但离线时旧额度不能按时过期的边界：暂停网络轮询但保留本地 TTL/五分钟/重置调度；在刷新尚未返回时也清理过期数据。隐藏/离线取消请求推进 sequence，晚到结果不能发布。确定性测试增加离线 TTL、离线 reset、在途刷新跨 reset、忽略 abort 的晚到响应场景。

源代码与 lockfile 版本均为 `0.3.10-dev.2`。类型检查、构建及全量测试通过：116 项，0 失败，0 跳过；使用独立 dev.2 tarball，没有覆盖 dev.1 包。dev.2 安装再次获得写入审批，组合配置/导入检查通过；已安装 manifest 为 dev.2，已安装 client bundle 与工作区构建 SHA-256 一致。新备份目录为 [dev.2 安装备份](</Users/wangzy/.dsh/profiles/web/.chatgpt-install-backups/2026-10-07T05-24-59-014Z/>)。

此处源码、构建和安装验证不能取代 GUI 验收。dev.2 安装后的新窗口发现、AX 树和最新截图再次确认：原窗口仍可用，模型为 GPT-6.1-Sol，模型左侧仍无额度条。这是 dev.2 的观测记录，不是已确定的加载根因；后续真实槽位契约诊断见下节。

### dev.3 未显示根因与修复

用户反馈仍未显示；新的 Desktop 进程和窗口加载后也没有额度条。重新核对真实宿主注册器发现：list 槽位要求 `options.id`，而 dev.1/dev.2 注册了 `key`，实际 `SlotCore.register` 在 [必需字段检查](</opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-slots/lib/index.js#L181-L184>) 抛错。因此“不显示”不能仅归因于未重启；之前的 mock 只记录注册对象，未检查 list/keyed 差异，测试没有捕捉这个问题。

dev.3 将该注册改为 `id: 'codex-five-hour-usage'`，并收紧前端手写注册类型、补充 mock 检查。新增测试使用已安装宿主的真实 SlotCore，声明 list 槽位并验证与另一贡献共存；旧构建稳定复现 `requires options.id`，修复后全量 117 项通过、0 跳过，类型检查与构建通过。测试不启动新 Host、不访问真实凭据。

当前源码与锁文件、已安装 profile 版本均为 `0.3.10-dev.3`，安装后的 client bundle 与工作区构建 SHA-256 一致。安装配置备份为 [dev.3 安装备份](</Users/wangzy/.dsh/profiles/web/.chatgpt-install-backups/2026-10-07T05-38-37-778Z/>)；安装仍报告已有 peer/schema 警告，没有隐去这些诊断。IDE 构建工具没有打开此项目，未构建其列出的无关 Java 项目，实际验证依据 npm/tsc 结果。

原 Desktop 窗口刷新后，模型左侧真实显示 Codex 5h、进度轨道和已用百分比，初次为 77%，后续随账号消耗更新到 80%–82%；跨 80% 后呈橙色。通过前台短暂投递 Space 验证键盘焦点详情，读取已用/剩余、重置、最后更新和再次检查时间；背景 AX/按键只证明投递，未错误认定其焦点成功。

最终真实 service 探针返回 ready、18000 秒、已用 81%、缓存一致，重置时间 `2026-10-07T08:50:04.000Z`，与 GUI 详情的本地 16:50:04 一致。探针与 UI 是不同查询时刻，不宣称两个查询的百分比必须相同。

窗口请求 375×900 时被原生最小尺寸约束为 900×900；实际 900px 窗口中额度条、模型与停止按钮同一行可见、无覆盖。已恢复原宽 2560px，未改变主题、模型、账号或凭据。这里不是 375px Web viewport 成功证据。[实际界面局部截图](<../.npm-cache/codex-five-hour-usage-dev3.png>) 只裁切原图，未改动百分比或 UI 内容。

窗口缩放后 AX 读取出现工具 `value is not lossless JSON` 错误，截图读取仍有效。后续使用截图确认原皮肤为 iOS 雾蓝，临时选择沉静蓝，关闭设置后验证深色下额度条与模型同一行可读，再选择原皮肤恢复；次日原 GUI 已是恢复后的浅色外观。未改动模型、账号或凭据。[深色实屏局部截图](<../.npm-cache/codex-five-hour-usage-dev3-dark.png>) 保存当时约 91% 的真实显示。完整读屏体验不以截图替代验证。

### dev.4 读屏语义与隔夜复核

进度条原先位于按钮后代中；按钮后代会被辅助技术当作展示内容，不能仅凭 JSX 有 role 就认定读屏可用。dev.4 保持视觉轨道不变，将独立 progressbar 放到按钮外并用非 display:none 的视觉隐藏样式保留；刷新按钮名称带 Codex 5h、已用百分比或未知状态。紧凑模式隐藏的是视觉轨道，不隐藏数值语义。回归覆盖 0%/42%/100%，旧实现先因嵌套失败，修复后类型检查、构建及 117 项测试通过、0 跳过。

2026-10-08 隔夜复核先发现窗口尺寸已由用户改为 1512×858，保留该尺寸、不还原昨日尺寸。原 GUI 已显示新窗口 0%，独立真实探针稍后为 ready、18000 秒、已用 1%、缓存一致，重置时间为 `2026-10-08T05:51:57.000Z`；不同采样时刻不作同次 HTTP 比对。昨日高占用未在新窗口继续显示。

当前源码与独立开发包为 `0.3.10-dev.4`，包内容检查未含 tests、探针、缓存或凭据。安装的普通权限调用被 web profile 写入权限拒绝；升级权限审批等待超时。超时后检查确认实际 profile 仍为 dev.3，已安装 client 哈希与新构建不同，无后台作业；没有重复启动安装，也不宣称 dev.4 已部署。这是首次 dev.4 安装审批超时的历史记录；后续获批安装结果见下段。

随后确认没有遗留作业或安装副作用后，重新提交同一安装命令并获得授权。安装成功，实际 profile 版本为 `0.3.10-dev.4`；client bundle 的 SHA-256 与测试构建均为 `021ade43ee387d52f721c85caf14192fadaa1143e818a74bb5db14c7a3bb7e50`，配置备份为 [dev.4 安装备份](</Users/wangzy/.dsh/profiles/web/.chatgpt-install-backups/2026-10-08T01-02-45-410Z/>)。peer/schema 警告仍如实保留，未升级 pnpm 或重启 Host。

在原 Desktop 的现有窗口重新加载界面后，真实 AX 树分别返回按钮名称「检查额度（受刷新间隔限制） · Codex 5h · 已用 4%」和独立 `AXProgressIndicator`「Codex 5h 已用」、值 4；直接证明新前端已加载、数值语义不再被按钮隐藏。后续采样增长到 5%，Space 键焦点激活后显示已用 5%/剩余 95%、最后更新时间、再次检查时间和重置 2026-10-08 13:51:57，与当天独立探针的 UTC 重置一致。没有修改当天用户的窗口尺寸、模型、账号或凭据。

服务端、前端、类型检查、构建、真实 Host 注册契约、117 项自动测试、独立开发包、本地部署、真实账号查询和当前环境可行 GUI 验证均已执行。本次开发目标可以结束；下列项目仍属于未覆盖的发布兼容性矩阵，而不是已通过的证据。

### 正式发布前未覆盖项与回退

- 原 GUI 模型左侧展示、浅色/深色主题、键盘详情、隔夜重置更新和 900px 原生最窄窗口已通过；约 375px Web viewport、VoiceOver 全流程及更多展开控件的组合布局未完成手工验收；dev.4 的真实 AX 独立进度数值和按钮可访问名称已验证。未取得浏览器网络日志，不宣称 UI 与同一条 HTTP 返回逐字段比对通过。
- 真实账号退出/重新登录/换账号未执行；目前以确定性测试验证身份失效，避免删除用户现有凭据。
- 上游解析依据链接到 main 的官方客户端源码及当前真实响应，未固定 Codex commit；不承诺 private usage API 长期兼容。
- 回退可重新安装本地已验证的 `0.3.9` 插件包；如需恢复 profile 配置，使用上述安装器备份。未执行回退演练，不清凭据或模型配置。

本开发包在记录这些后续事实之前生成并安装，包内方案仍为当时快照；当前源码目录的本文件保存最新验收状态。正式发布前应完成 GUI 验收，再重建独立正式版本包。
