# dsh-codex 0.3.8 新版本缺陷与风险汇总

> 项目：`tanuki-cat/dsh-codex`\
> 审查版本：`0.3.8`\
> 审查目标：评估“补充旧版 pi-ai 缺失 Codex 模型”功能在当前实现中的缺陷、边界与后续改进方向。

## 总体结论

`dsh-codex 0.3.8` 已经可以解决旧版 `pi-ai` 因模型目录滞后导致的 `UNKNOWN_MODEL` 问题，并且整体设计比早期版本完整很多。

当前实现的核心路径是：

```text
ChatGPT / Codex OAuth
        ↓
获取当前账号可见 Codex 模型目录
        ↓
与 DSH / pi-ai 当前可选模型比较
        ↓
生成缺失模型补丁预览
        ↓
用户确认
        ↓
写入 llm-pi-ai.providers.openai-codex.models
        ↓
继续复用 pi-ai 原有 Codex 协议与 OAuth 能力
```

这个方向是正确的，但目前仍存在两类问题：

1. **会直接影响长上下文、模型目录和用户体验的实际缺陷。**
2. **由当前“显式 models 快照”架构带来的长期维护风险。**

建议至少在下一版本中优先修复上下文窗口语义、错误原因展示、签名稳定性和热更新确认问题。

---

## 问题优先级总览

| 优先级 | 问题 | 影响 |
|---|---|---|
| P0 / 高 | `max_context_window` 被直接作为 `contextWindow` 使用 | 可能导致 DSH 过晚压缩、上下文溢出或行为与 Codex 默认语义不一致 |
| P0 / 中高 | 显式 `models` 会整体接管 pi-ai 原生 catalog | 容易形成长期目录快照，后续 pi-ai 升级可能被旧配置压住 |
| P1 / 中 | Preview fallback 的具体 reason 在 UI 中丢失 | 用户只能看到“远端目录不可用”，无法知道真实处置方式 |
| P1 / 中 | OAuth access token 过期时补丁不会主动 refresh | 用户可能必须先运行一次模型请求，再回来检查缺失模型 |
| P1 / 中 | preview/apply 签名对模型顺序敏感 | 仅排序变化也会触发无意义 conflict |
| P1 / 中 | 写入后立刻验证模型注册存在热更新竞态 | 实际写入成功仍可能出现 `registration-unconfirmed` |
| P2 / 低中 | `client_version` 硬编码 | 上游 Codex 更新后可能影响新模型发现 |
| P2 / 低中 | 新模型 descriptor 只补部分字段 | 能解决 `UNKNOWN_MODEL`，但不保证具备新版 pi-ai 的完整模型能力 |

---

# 1. `max_context_window` 语义使用存在风险

## 当前实现

0.3.8 当前大致按照以下优先级决定新增模型的上下文窗口：

```ts
const contextWindow =
  positive(model.max_context_window)
  ?? positive(model.context_window)
```

也就是当远端同时返回：

```text
context_window     = 272000
max_context_window = 872000
```

时，最终会写入：

```text
contextWindow = 872000
```

## 风险

OpenAI Codex 上游对这两个字段的语义并不完全等价。

从上游当前模型结构来看：

```rust
pub context_window: Option<i64>

/// Maximum context window allowed for config overrides.
pub max_context_window: Option<i64>
```

其默认解析逻辑是：

```rust
pub fn resolved_context_window(&self) -> Option<i64> {
    self.context_window.or(self.max_context_window)
}
```

也就是说：

- `context_window` 更接近默认有效窗口；
- `max_context_window` 更接近允许 override 的最大上限；
- Codex 自己默认是优先使用 `context_window`。

如果插件直接将 `max_context_window` 写成 DSH 的默认 `contextWindow`，可能导致：

```text
Codex 默认上下文：272K
DSH 认为上下文：872K
```

随后 DSH 的 token meter / compaction 策略可能明显推迟。

例如假设 90% 时开始考虑压缩：

```text
272K → 约 245K
872K → 约 785K
```

对于 Agent Coding 长会话，这个差异非常大。

## 建议修复

默认应改为：

```ts
const contextWindow =
  positive(model.context_window)
  ?? positive(model.max_context_window)
```

并将 `max_context_window` 单独保留为：

```text
最大可配置窗口
```

如果未来希望使用超长上下文，应让用户显式 opt-in，而不是自动采用最大值。

推荐 UI：

```text
默认上下文窗口：272K
最大可配置窗口：872K
```

---

# 2. 显式 `models` 会形成目录快照

## 当前实现

新增模型最终写入：

```text
llm-pi-ai.providers.openai-codex.models
```

当前实现为了避免覆盖现有模型，会先将运行时当前模型全部复制进去，再追加缺失模型。

这已经解决了旧版本中“写一个模型导致其余模型消失”的问题。

## 仍然存在的风险

该字段本质上仍然是：

```text
显式 models
    ↓
整体替换 provider 默认模型目录
```

而不是：

```text
pi-ai 原生 catalog
      +
missing model overlay
```

因此它更接近“当前目录的快照”。

例如当前旧版 pi-ai：

```text
gpt-6-sol
gpt-6-luna
gpt-6-astra
```

插件补：

```text
gpt-6.1-sol
```

最终保存为：

```text
models:
  - gpt-6-sol
  - gpt-6-luna
  - gpt-6-astra
  - gpt-6.1-sol
```

以后 pi-ai 升级后新增：

```text
gpt-6.1-luna
gpt-6.1-astra
```

如果显式 `models` 仍然存在，则新版 pi-ai 的原生 catalog 可能仍被旧快照压住。

## 后果

可能出现：

```text
pi-ai 已升级
     ↓
官方模型目录已经更新
     ↓
旧的 dsh-codex models 配置仍覆盖目录
     ↓
用户看不到新版 pi-ai 新增模型
```

再次运行“检查缺失模型”可以重新并入，但不是自动完成。

## 建议方向

理想方案是 runtime overlay：

```text
pi-ai 原生 catalog
       │
       ├─────────────┐
       │             │
       ▼             ▼
   原生模型      missing models
       │             │
       └──────┬──────┘
              ▼
       最终 runtime catalog
```

如果当前 DSH API 不支持 overlay，可考虑增加：

- “重新同步模型目录”功能；
- pi-ai 版本变化后自动提示重新检查；
- 检测到原生模型已补齐后自动清理对应 override；
- 提供“恢复使用 pi-ai 原生目录”按钮。

---

# 3. Preview fallback 的错误原因会被 UI 吃掉

## 当前行为

服务端 preview 出错时，大致会：

```ts
catch (error) {
    const reason = reasonOf(error)
    reply(200, await patch.fallback(reason))
}
```

即使实际错误是：

```text
route-missing
settings-read-only
credential-expired
source-unavailable
```

HTTP 状态仍然是 200。

fallback payload 中虽然保留：

```ts
{
  unavailable: "...",
  reason: "route-missing",
  ...
}
```

但客户端主要在：

```ts
if (!response.ok) {
    setPatchReason(...)
}
```

这一路径读取错误 reason。

结果就是：

```text
HTTP 200
+
reason = route-missing
```

可能只显示：

```text
远端目录不可用，仅显示已安装模型
```

而不是更准确的：

```text
尚未声明 openai-codex 路由，请先从目录添加
```

## 影响

用户无法区分：

- route 未配置；
- credential 已过期；
- 设置只读；
- Codex endpoint 暂不可用；
- 其它服务端错误。

这会显著增加排查成本。

## 建议修复

客户端拿到成功响应后也检查：

```ts
if (value?.unavailable) {
    setPatch(value)
    setPatchReason(value.reason ?? "source-unavailable")
    return
}
```

同时增加测试：

```text
HTTP 200
unavailable != null
reason = route-missing
```

并验证最终 UI 会显示正确原因。

---

# 4. OAuth access token 过期时不会主动刷新

## 当前行为

模型补丁查询会直接检查保存的 OAuth grant：

```ts
if (grant.expires <= Date.now()) {
    throw new PatchError("credential-expired", ...)
}
```

但正常 pi-ai inference 本身拥有 OAuth refresh 能力。

于是可能出现：

```text
access token expired
refresh token 正常

模型推理：
    pi-ai 自动 refresh
    → 正常

检查缺失模型：
    直接 credential-expired
    → 无法继续
```

## 用户体验

可能变成：

1. 用户打开插件；
2. 点击“检查缺失模型”；
3. 提示 token 已过期；
4. 用户必须先去运行一次模型请求；
5. pi-ai 自动刷新 token；
6. 再回来重新检查。

功能可以绕过去，但流程不自然。

## 建议

模型目录查询应尽量复用：

```text
pi-ai credential resolver
+
OAuth refresh path
```

而不是直接读取 CredentialStore 中尚未刷新的 access token。

如果当前架构无法直接复用，至少可以提供：

```text
刷新登录状态并重试
```

按钮，而不是只让用户自行触发一次推理。

---

# 5. Preview / Apply 签名对模型排序敏感

## 当前设计

Preview 会生成 fingerprint，大致包含：

```text
accountId
revision
catalog.entries
catalog.limited
original
current
```

Apply 时会重新读取 catalog 和当前 runtime models，再计算一次签名。

这个设计本身是正确的，可以避免 TOCTOU：

```text
预览之后
配置或远端目录发生变化
→ 拒绝继续写入
```

## 问题

参与 fingerprint 的数组如果没有先 canonicalize：

```text
A, B, C
```

与：

```text
B, A, C
```

会得到不同 fingerprint。

即使模型内容完全相同，仅远端接口或宿主调整了返回顺序，也会产生：

```text
preview signature != apply signature
```

用户收到：

```text
模型来源或配置已变化，请重新预览
```

但实际上没有真实变化。

## 建议修复

签名前对所有集合型字段排序：

```ts
models.sort((a, b) => a.id.localeCompare(b.id))
```

对于 reasoning levels 等子字段也建议做稳定排序。

fingerprint 应只对“语义变化”敏感，而不是“遍历顺序变化”敏感。

---

# 6. 写入后立即验证模型注册可能存在热更新竞态

## 当前流程

Apply 大致是：

```text
settings.mutate(...)
    ↓
立即 services.llm.listModels(...)
    ↓
检查新增模型是否已经出现
```

如果没有出现，则返回：

```text
registration-unconfirmed
```

## 风险

这隐含假设：

```text
settings.mutate resolve
    =
runtime catalog 已完成刷新
```

但如果未来或某些宿主版本内部是异步热更新：

```text
mutate resolve
    ↓
listModels()
    ↓
仍是旧目录
    ↓
registration-unconfirmed
    ↓
100~300ms 后真正刷新完成
```

用户会看到假失败。

尤其当前项目对真正 DSH：

```text
SettingsForms
→ configEditor.edit
→ cordis.patch.yml
→ runtime reload
```

完整落盘 / 热加载链路的集成测试仍然有限。

## 建议

写入后做短轮询：

```text
立即检查
100 ms
250 ms
500 ms
1000 ms
```

达到模型已出现即可成功。

总等待时间不需要太长，1~2 秒足够。

---

# 7. `client_version` 硬编码存在未来兼容风险

## 当前状态

插件当前使用固定 Codex client version，例如：

```text
0.160.1
```

在当前上游版本下可以正常工作，因此现在不是严重 bug。

## 风险

如果未来 Codex backend 根据 client version 控制：

- 模型可见性；
- 新字段；
- capability；
- rollout；
- API schema；

插件可能再次出现：

```text
真实账号已有新模型
但 dsh-codex 查询不到
```

## 建议

优先级可以是：

```text
1. 从本机 Codex CLI 获取当前版本
2. 从 package / runtime metadata 获取
3. 插件内置 fallback version
```

并在诊断页显示实际发送的 client version。

---

# 8. 新模型 descriptor 只补了部分能力

## 当前补丁主要覆盖

目前缺失模型主要构造：

```text
id
name
contextWindow
input modalities
reasoningEfforts
```

这足够解决：

```text
UNKNOWN_MODEL
```

以及基本模型选择。

## 没有完整补充

例如：

```text
maxTokens
pricing
cache pricing
compat flags
特殊工具能力
verbosity
协议特性
新 reasoning 行为
未来新增 capability 字段
```

## 影响

“模型能被 DSH 选中”不等于：

```text
拥有新版 pi-ai 对该模型的完整支持
```

如果新模型只是复用旧 Codex Responses 协议，通常问题不大。

如果未来新模型引入：

```text
新的 request 字段
新的 reasoning 级别
新的 tool-call semantics
新的响应事件
新的 multimodal 能力
```

旧 pi-ai 仍然可能失败。

## 建议

UI 应继续明确区分：

```text
目录已补充
模型可解析
实际推理已验证
完整能力已支持
```

不要将这四件事视为同一个状态。

---

# 推荐的 0.3.9 修复优先级

## P0

### 1. 修正上下文窗口语义

从：

```ts
max_context_window ?? context_window
```

改成：

```ts
context_window ?? max_context_window
```

并把最大可配置窗口单独展示。

### 2. 改善显式 models 的长期目录接管问题

至少增加：

- 恢复原生目录；
- 重新同步；
- 原生模型已补齐后的 override 清理提示。

---

## P1

### 3. 修复 fallback reason UI

HTTP 200 fallback 也必须显示真实 reason。

### 4. fingerprint canonicalize

所有参与签名的集合按稳定规则排序。

### 5. registration confirmation 增加 retry

避免热加载 race 导致假失败。

### 6. OAuth 查询复用 refresh

检查缺失模型不应要求用户先手工触发一次 inference。

---

## P2

### 7. client version 动态化

避免未来 Codex backend 因版本门控导致 catalog 落后。

### 8. 扩展模型 capability 映射

在 pi-ai / DSH schema 支持的前提下逐步补充：

```text
maxTokens
更多 capability
兼容参数
协议元数据
```

---

# 推荐的理想架构

当前：

```text
Codex remote catalog
        ↓
diff
        ↓
复制当前 pi-ai catalog
        +
missing models
        ↓
持久化 explicit models
        ↓
替换 route catalog
```

长期更理想：

```text
             pi-ai 原生 catalog
                    │
                    │
Codex remote catalog
        │           │
        ▼           ▼
     diff missing models
             │
             ▼
       runtime overlay
             │
             ▼
       resolved catalog
```

优势：

- pi-ai 升级后自动继承官方新模型；
- 插件只维护真正缺失的 entry；
- 原生 descriptor 永远优先；
- 不需要长期保存整份 catalog 快照；
- pi-ai 原生补齐模型后 override 可以自动失效。

---

# 验收建议

修复后建议至少增加以下测试。

```text
1. context_window 和 max_context_window 同时存在
   → 默认采用 context_window

2. 只有 max_context_window
   → fallback 使用 max_context_window

3. HTTP 200 fallback + reason=route-missing
   → UI 显示 route-missing 对应提示

4. catalog 顺序变化
   → preview/apply fingerprint 保持一致

5. runtime listModels 顺序变化
   → fingerprint 保持一致

6. mutate 后第一次 listModels 仍旧
   第二次刷新成功
   → apply 最终成功

7. access token expired + refresh token valid
   → catalog 查询能够自动刷新

8. pi-ai 升级后新增原生模型
   → explicit models 不应永久屏蔽新模型

9. 已被新版 pi-ai 原生支持的 patched model
   → 可以安全移除 override

10. 重复执行模型补丁
    → 幂等，不重复写入，不破坏已有显式配置
```

---

# 最终判断

`dsh-codex 0.3.8` 已经具备实际使用价值，特别适合解决：

```text
旧 pi-ai
+
Codex 新模型已经对账号开放
+
本地 catalog 尚未更新
```

这种场景。

但当前版本仍不应被视为“完整替代新版 pi-ai 模型支持”。

最值得优先修复的是：

```text
1. context_window / max_context_window 语义
2. explicit models 长期接管 catalog
3. fallback reason 丢失
4. OAuth refresh
5. fingerprint 顺序敏感
6. 热更新确认 race
```

如果仅用于让旧 pi-ai 临时使用 `gpt-6.1-sol`，0.3.8 的方向是可行的；但在长期维护和长上下文行为上，建议完成上述修复后再将其作为稳定机制长期使用。
