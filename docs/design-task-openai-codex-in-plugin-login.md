# 从插件内点击完成 openai-codex 登录与路由声明

> 状态：待实施。本文记录已验证的宿主机制、未验证的风险点，以及分阶段实施方案。
> 前置：官方 `openai-codex` 路由已在本机跑通（OAuth 授权、真实推理 HTTP 200、轮内缓存命中 97.5%）。当前需手工执行 `scripts/login-openai-codex.mjs` 与 `scripts/add-openai-codex-route.mjs`。

## 目标

把两个手工脚本替换为插件内的图形操作，达到：

1. 在 DSH 设置页的 `openai-codex` provider 卡片上出现「登录 ChatGPT」按钮；
2. 点击后完成 OAuth，凭据写入 `llm-pi-ai/openai-codex`；
3. 路由声明（当前需写 profile）自动完成，无需用户编辑配置文件；
4. 全过程不需要重启 DSH。

## 已验证的宿主机制

### 1. provider 卡片扩展槽位可用且为空

`settings.models.provider-card` 是 keyed 槽位，按 `settingsNs` 分发，`ModelsSection.tsx` 在每一行 provider 卡片上渲染它：

```tsx
renderSlot(
  'settings.models.provider-card',
  { provider: row.entry, configured: row.configured, keyConfigured: keyConfiguredOf(row) },
  { entryKey: row.entry.settingsNs },
)
```

槽位目录明确记录 `keyDomain: open: any string the owner dispatches (no compile-time key set), none are taken yet`，且 `dsh-llm-pi-ai` **没有伴随的前端包**（其 `package.json` 无 client 导出）。因此以 `entryKey = 'llm-pi-ai'` 注册即可占位，不会与官方冲突。

`settingsNs` 由 `ctx.fiber.entry?.options.id ?? NS` 决定（`packages/llm/llm-pi-ai/src/index.ts:151`），即 profile 中的插件条目 id，本机为 `llm-pi-ai`。

### 2. 配置可运行时写入，且热生效

`ctx.settings.update(ns, patch, expectedRevision)` 是受支持的写入路径：

- `SettingsForms.write()` 通过 `ownerContext.configEditor.edit(entry, ...)` 落到 profile 配置文档；
- 目标字段必须在 schema 中标记 `.volatile()` —— `providers` **满足**：`providers: z.dict(profile).default({}).volatile()`（`packages/llm/llm-pi-ai/src/config.ts:353`）；
- 非 volatile 字段会被显式拒绝：`throw new Error('Config field "..." is not volatile')`；
- 写入后 `llm-pi-ai` 监听 `loader/volatile-update` 重建路由（`packages/llm/llm-pi-ai/src/index.ts:310`），无需重启。

`dsh-api-settings-controller` 把它暴露为 remote：`update` / `replace` / `mutate`（带 `expectedRevision` 做并发保护）。`llm-pi-ai` 自己就调用了 `child.settings.configure({ auto: false })`，说明该命名空间可写。

### 3. 路由声明其实已有原生 UI 路径（推翻阶段二的前提）

实施前调查发现：**Models 设置页自带 `addCatalog` 模式**，可从下拉框选择未被声明的 catalog provider 并直接添加，无需手写配置。

- 模式判定：`const mode = bothOffered ? addMode : customOffered ? 'custom' : 'catalog'`；
- 可添加集合：`addable = state.rows.filter(row => !row.configured && 命名空间已挂载)`；
- 写入路径：`operations.writeSettings(ns, ops, revision)` → `ctx.remote.settings.mutate(...)`，与插件自己调用 `ctx.settings.update` 是**同一条**受支持通道；
- 该模式对 `llm-pi-ai` 命名空间可用（`customOffered = piAi !== undefined`）。

因此阶段二（插件内自动写路由）**降级为可选优化**：用户在 Models 页选择 `openai-codex` 并确认即可完成声明，无需跑脚本、也无需插件代写配置。

这也意味着方案 C 的真实范围收缩为**单一缺口：登录按钮**。路由声明不属于缺口。

### 4. 官方端点与模型可用性（本机实测）

| 模型 | 官方 catalog | 端点实测 |
| --- | --- | --- |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` / `gpt-5.5` / `gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna` / `gpt-5.3-codex-spark` | 有 | — |
| `gpt-6.1-sol` | **无** | **HTTP 200 可用** |

`gpt-6.1-sol` 是本机旧插件 `extraModels` 中的手动条目。官方 catalog 不含它，但账户实际有权调用，因此方案 A 需要为它显式声明模型条目（见阶段三）。

推理端点是 `https://chatgpt.com/backend-api/codex/responses`（不是 `/v1/responses`），需要 `chatgpt-account-id` 与 `originator` 请求头。

## 未验证的风险点

以下三项在实施前**尚未实测**。第 1、3 项已在方案 A 中验证（见文末实施结果），第 2 项的结论是无需验证——路由声明由 Models 页的 `addCatalog` 承担，插件不再代写配置。

1. **`settings.update` 从插件内调用的实际行为**。已确认代码路径存在，但未实测：(a) `providers` 的 dict-of-object 是否为 `validatePaths` 接受的 volatile 形状；(b) 写入后 `assertServiceable` 是否接受该 profile；(c) 是否真的无需重启。
2. **与 `llm-pi-ai` 写入的竞争**。设置页与该插件可能同时写同一命名空间，需依赖 `expectedRevision` 冲突检测（`SettingsConflictError`），未验证实际表现。
3. **OAuth 在宿主的授权缝内运行**。官方 pi-ai 的 flow 已注册（`registerPiAiFlows`），理论上可直接 `ctx.authorization.begin({ key: 'llm-pi-ai/openai-codex' })`，但该调用**没有前端消费者**，其 notify 事件如何投影到设置页尚未验证。

## 实施方案

分三个阶段，每阶段独立可验收，失败可停在该阶段。

### 阶段一：provider 卡片上的登录按钮（低风险）

1. 插件保留 `src/management.js` 的管理路由（token 校验、来源检查已在用），新增操作 `POST /login-codex`；
2. `src/auth.js` 的职责从自建 OAuth 改为调用 `ctx.authorization.begin({ key: 'llm-pi-ai/openai-codex' })`，复用官方已注册的 flow；
3. `src/client.js` 增加一个注册到 `settings.models.provider-card`（`entryKey: 'llm-pi-ai'`）的组件，按钮调用上述管理路由；
4. 保留轮询以反映授权进度。

验收：点击按钮能打开浏览器完成 OAuth，`~/.dsh/.credentials.yaml` 出现 `llm-pi-ai/openai-codex`。

**回退**：删除该槽位注册即可，不影响现有 `chatgpt-plan`。

### 阶段二：路由声明自动化（可选，已被原生 UI 覆盖）

> **前提已变更**：Models 页自带 `addCatalog` 模式，用户可在界面直接添加 `openai-codex`。本阶段仅在需要「一次点击同时完成登录与声明」时才做；否则跳过。

1. 管理路由新增 `POST /ensure-route`，内部调用 `ctx.settings.update('llm-pi-ai', { providers: { 'openai-codex': { reasoning: 'medium' } } }, revision)`；
2. 先 `describe()` 读取 revision 与现状，避免重复写入；
3. 写入后通过 `llm/adapters-updated` 或轮询确认路由已注册，再回报前端；
4. 失败时把 `SettingsConflictError` 与 `assertServiceable` 的拒绝原因如实回报，不回退到写文件。

验收：全新 profile（`providers` 中没有 `openai-codex`）执行一次点击后，模型选择器出现该 provider，且 `cordis.patch.yml` 被正确更新。

**待验证**：如果 `settings.update` 无法写入 dict 形状，则退回 `writeFile + 提示重启`，并在本文记录结论。

### 阶段三：模型条目与清理（收尾）

1. 为 `gpt-6.1-sol` 增加显式模型条目（官方 catalog 不含，但端点可用）：

```yaml
openai-codex:
  reasoning: medium
  models:
    - id: gpt-5.6-sol
      reasoningEfforts: { low: low, medium: medium, high: high, xhigh: xhigh, max: max }
    - id: gpt-6.1-sol
      name: GPT-6.1 Sol
      contextWindow: 400000
      reasoningEfforts: { low: low, medium: medium, high: high, xhigh: xhigh, max: max }
```

注意 `models` 是**整体替换** catalog 而非追加：一旦列出就需列全所需模型。若只想新增一个，用 `modelOverrides`（仅限 catalog 已有的 id），因此 `gpt-6.1-sol` 必须走 `models` 全量列表。

2. 确认 `chatgpt-plan` 不再被使用后，从 profile 移除 `llm-chatgpt` 条目并卸载 `dsh-llm-chatgpt` 包；
3. 迁移凭据：删除 `llm-chatgpt/*` 记录（或保留，不再被读取）。

验收：模型选择器只保留 `openai-codex` 路由，重启后无诊断。

## 方案 A 实施结果（0.2.6）

阶段一已实施：插件现在自带官方 `openai-codex` 的登录入口。

### 变更

| 文件 | 作用 |
| --- | --- |
| `src/codex.js` | 新增。定位 llm-pi-ai 注册的 flow、驱动登录、读取账户展示信息；不含任何协议实现 |
| `src/management.js` | 新增 `createCodexManagement` 与 `registerCodexManagement`；抽出 `injectConnection` / `serve` 复用两条路由 |
| `src/index.js` | 仅当 `ctx.authorization.describe('llm-pi-ai/openai-codex')` 存在时注册该路由 |
| `src/client.js` | 新增注册到 `settings.models.provider-card`（`key: 'llm-pi-ai'`）的卡片；原有 settings.section 页面不变 |

### 关键设计

- **不实现协议**：登录完全交给 pi-ai 自己的 `openaiCodexOAuth`，凭据由 pi-ai 的 store 经 `credentials.modifyRecord` 写入，因此宿主的 `observed.committed` 能正确观测到提交，`begin()` 正常返回 `authorized`。
- **按 flow 是否存在决定是否注册**：没有 llm-pi-ai 的组合不注册该端点，前端因此不会显示一个必然失败的按钮。
- **两条路由互不影响**：`chatgpt-plan` 的管理页与 `openai-codex` 的卡片各自独立，插件可并行服务两条路由。
- **账户展示不泄漏令牌**：只解出 JWT 的 plan / name / email / 到期时间；测试断言响应中不含 access、refresh 或签名片段。

### 验证

- `npm test`：86 个测试，未设 `DSH_INSTALL_ROOT` 时 83 通过 3 跳过；设置后 86 全部通过。
- 新增 `tests/codex.test.js`（7 个用例）覆盖 flow 缺失、登录通知、提交后状态、取消与退出、令牌不泄漏、路由 capability 校验。
- 新增 `tests/installed-codex.test.js` 用**真实** AuthorizationService 与 webServer：注册 flow 时端点出现且 index 注入携带路径与 token；未注册时不出现。

### 仍未验证

- 真实浏览器点击完成一次 OAuth（需要人工操作）。
- 阶段二（插件代写路由）未实施——Models 页的 `addCatalog` 已覆盖该需求。

## 依据

- `packages/client/ui-settings-models/src/client/slot-contract.ts`：provider-card 与 sign-in 槽位契约
- `packages/client/ui-settings-models/src/client/ModelsSection.tsx`：卡片渲染与 `entryKey` 分发
- `packages/settings/settings/src/index.ts`：`write()` 的 volatile 校验与 `configEditor.edit`
- `packages/llm/llm-pi-ai/src/config.ts`：`providers` 的 `.volatile()` 标记
- `packages/llm/llm-pi-ai/src/index.ts`：`loader/volatile-update` 热重建路由
- `packages/api/settings-controller/src/index.ts`：`update` / `replace` / `mutate` remote
- `packages/llm/llm-pi-ai/src/login.ts`：官方 flow 的注册条件
- 本机实测：`chatgpt.com/backend-api/codex/responses` 对 `gpt-6.1-sol`、`gpt-6-sol`、`gpt-5.6-sol` 均返回 HTTP 200
