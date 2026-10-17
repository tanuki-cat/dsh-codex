---
description: "0.3.14 当前源码的审查问题、证据，以及 F1–F3 的修复与验证记录。"
kind: "reference"
---

# 0.3.14 代码审查与处理记录

> 状态：审查完成；F1–F3 已修复并验证，随 `0.3.15` 发布（见 [0.3.15 发布说明](<design-task-release-codex-rc1-compat-0.3.15.md>)与[更新日志](../CHANGELOG.md)）；F4–F5 作为未处理建议保留。
> 关系：本文只描述本次审查与处理，不替代 [README](../README.md) 与 [更新日志](../CHANGELOG.md) 对当前行为的说明。历史审查见 [0.3.8 缺陷与风险审查](dsh-codex-0.3.8-code-review.md) 与 [0.3.9 处理记录](design-task-fix-codex-model-patch-review-0.3.9.md)。

## 概要

对 `0.3.14` 当前工作区做只读审查：未发现可远程利用的鉴权绕过、注入或凭据泄露；发现 3 项应处理问题（被放弃的登录会无限期降级额度服务、图片响应处理的内存放大、目录预览缺少并发合并）与 2 项边界健壮性问题。F1–F3 已修复，新增 5 项测试；完整套件 185 项中 184 项通过、0 失败、1 项按约定单独运行通过。

## 目录

- [审查范围与方法](#审查范围与方法)
- [问题清单](#问题清单)
- [处理记录](#处理记录)
- [已核查未见问题的部分](#已核查未见问题的部分)
- [验证记录](#验证记录)
- [未覆盖与边界](#未覆盖与边界)
- [后续维护](#后续维护)

## 审查范围与方法

- 对象：[服务端插件](<../src/index.ts>)、[管理路由](<../src/management.ts>)、[额度服务](<../src/usage.ts>)、[模型补丁](<../src/model-patches.ts>)、[图片接口与服务](<../src/image-api.ts>)、[设置页客户端](<../src/client.ts>)、[辅助脚本](<../scripts/>)、[测试](<../tests/>)与[版本配置](<../config/codex.json>)。
- 事实来源：源码阅读；`npm run build`；完整单元与宿主集成测试；两个独立探针（管理端点主机/来源用例矩阵、图片响应内存测量）；已安装宿主 `0.2.1-alpha.2` 的 pi-ai、authorization 与 credentials 实现（`~/.dsh/profiles/node_modules`、`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`）。
- 审查阶段只读取证、未改代码；报告后按用户要求实施 F1–F3。

## 问题清单

| 编号 | 严重度 | 问题 | 位置 | 状态 |
| --- | --- | --- | --- | --- |
| F1 | 中 | 被放弃的登录让额度服务无限期返回 `sign-in-required`，并持续 500 ms 轮询 | [management.ts](<../src/management.ts>)、[usage.ts](<../src/usage.ts>)、[client.ts](<../src/client.ts>) | 已修复 |
| F2 | 中 | 图片响应处理的瞬时内存放大：20 MiB 载荷整条路径探针峰值 `rss +128.7 MB`、`external +100 MB` | [image-api.ts](<../src/image-api.ts>) | 已修复 |
| F3 | 低-中 | 目录预览无并发合并，`apply` 会再跑一遍完整预览 | [model-patches.ts](<../src/model-patches.ts>) | 已修复（方案调整，见下） |
| F4 | 低 | 单个畸形 `trustedHosts` 条目会让整条校验抛错拒绝 | [management.ts](<../src/management.ts>) | 未处理 |
| F5 | 低 | `isWildcardBind` 未覆盖 `0:0:0:0:0:0:0:0` 等 IPv6 全零写法 | [management.ts](<../src/management.ts>) | 未处理 |

### F1 证据链

1. 插件的登录提示对非 `select` 请求返回永不 resolve 的 Promise，只靠 abort 结束（[codex.ts](<../src/codex.ts>)）。
2. 宿主 pi-ai 的浏览器登录等待回调且未传 `timeoutMs`（`startOAuthCallbackServer` 只在显式传参时启动计时器），DSH 的 authorization seam 也只维护 `inFlight`，两者都没有期限。
3. `start()` 在发起登录前暂停额度查询，解除只发生在 attempt 的 `finally`；attempt 不结束则暂停不解除。
4. `get()` 在暂停期间直接返回 `sign-in-required`，刷新页面无法清除（标志在服务端闭包内），必须点取消或重启 DSH。
5. 客户端在 `pending` 时固定 500 ms 轮询 `/status`，每次读取一次凭据记录（`credentials-local` 为内存缓存，主要代价是常驻请求速率而非磁盘 IO）。

### F2 证据

`--expose-gc` 探针（20 MiB PNG，走真实 `generateImage`）：解码步骤 `+46.7 MB` / 44.8 ms；整条路径实测 `rss +128.7 MB`、`external +100 MB`。原因是同一请求同时驻留分块列表、`Buffer.concat` 副本、JSON 文本、解析结果、20 MB 图片缓冲与 `toString('base64')` 再编码串。

### F3 证据

`/models-preview` 每次 GET 都重新请求远端目录（7 s 超时、≤4 MiB），`apply()` 内部再次执行完整 `preview()`，两处都未合并并发请求。

## 处理记录

### F1 登录尝试加上限、轮询退避、超时可见

- 服务端：新增 `SIGN_IN_TIMEOUT_MS`（10 分钟）与可注入的 `options.loginTimeoutMs`；超时通过 attempt 自己的 `AbortController` 结束流程，状态落到 `failed` 并带 `errorKind: 'timeout'`，`finally` 清除计时器、释放 `active` 并恢复额度查询（[management.ts](<../src/management.ts>)、[types.ts](<../src/types.ts>)）。
- 客户端：`pending` 轮询改为 500 ms → 1 s → 2 s 封顶的退避，非 pending 时复位；卡片对 `errorKind === 'timeout'` 显示专用中英文案，不再无提示地回到未连接状态（[client.ts](<../src/client.ts>)）。
- 影响：一次被放弃的登录最多占用 10 分钟；之后可重新发起，额度查询自动恢复。插件在方法选择上恒选第一项（浏览器登录），pi-ai 的设备码分支不被本插件使用。
- 边界：不改变其它失败原因的呈现方式；服务端 `error` 文本仍不直接展示给页面。

### F2 去掉整段再编码，改单缓冲读体

- `decodeImageResponse` 用最终 quantum 的 padding 位校验替代 `data.toString('base64') !== encoded` 整段往返；两者等价（base64 解码器忽略的尾部比特必须为零），并补了同源变异串的等价性测试（[image-api.ts](<../src/image-api.ts>)、[image-api.test.ts](<../tests/image-api.test.ts>)）。
- `readJson` 用自持的增长缓冲替代「分块列表 + `Buffer.concat`」：读取时即复制并释放上游分块，上限检查仍在每个分块之后（[image-api.ts](<../src/image-api.ts>)）。
- 实测：解码步骤存活分配 `external +46.7 MB → +20.0 MB`、耗时 `44.8 ms → 30.1 ms`（20 MiB 载荷，`--expose-gc`，同一段代码前后对比）。整条路径的 `rss` 受 V8 堆增长策略影响，不作为对比指标。
- 曾尝试：用流式 `TextDecoder` 逐块解码以避免拼接。实测在 Node 下反而更差（解码结果按两字节字符串计入 external，峰值 `+80 MB`），已回退为单缓冲方案。
- 残余：整个请求仍同时持有 JSON 文本与其解析结果，以及 HTTP 响应体缓冲；`MAX_IMAGE_BYTES` 保持 20 MiB，实际上限仍取宿主 `imageLimits` 的较小者。

### F3 只合并并发请求（方案调整）

- 实现：`createModelPatches` 按 `accountId`、access token（SHA-256 摘要，不保留原文）与请求版本合并进行中的目录请求；请求一结束就清除条目，下一次预览必然重新拉取。
- 方案调整：审查时建议的「短 TTL 缓存」被既有契约否决——[model-patches 测试](<../tests/model-patches.test.ts>) 要求语义变化的目录必须让确认失效（`a semantic catalog change still invalidates a confirmation`），任何 TTL 都会让 `apply` 跳过这次必需的复核。因此 `apply` 重新拉取一次目录是签名语义，不是遗漏；本次只消除并发放大。
- 测试：两个并发 `preview()` 只发一次请求，随后的 `preview()` 重新拉取。

### F4 / F5 未处理

- F4：`trustedHosts` 中出现无法解析的条目时，`new URL()` 抛出会被外层 catch 吞掉并整体拒绝。行为是 fail-closed（不越权），但用户一个手误就可能让卡片整体 403；修它需要改动信任栅栏的取反逻辑，留作单独变更并配负向测试。
- F5：`0:0:0:0:0:0:0:0` 未被识别为通配绑定。当前无法被利用——Host 经 WHATWG 规范化后匹配不到该字面量，既不放行也不误拒——属语义完备性问题。

## 已核查未见问题的部分

- **能力令牌**：32 字节随机 hex，`timingSafeEqual` 且长度不等直接拒绝；`/status`、`/usage`、`/login|cancel|logout`、`/models-*` 全部先校验。
- **主机与来源**：拒绝 userinfo、path、query、hash；loopback 覆盖 `localhost`、`[::1]`、`127.0.0.0/8`（WHATWG 规范化让 `2130706433`、`127.1` 也正确判为回环）；`sec-fetch-site: cross-site`、不匹配的 `Origin`、`origin: 'null'` 均拒绝。14 组探针用例覆盖 DNS rebinding 与跨站读取路径。
- **注入面**：index 注入脚本只拼接常量与 `randomBytes`；客户端无 `dangerouslySetInnerHTML`；无 `eval`；唯一的外部进程调用是固定参数的 `codex --version`（1.5 s / 4 KiB 上限）。
- **出网与错误脱敏**：全部 https 且 `redirect: 'error'`；图片诊断只保留白名单常量；管理路由失败一律回固定文案，不回显上游正文或异常原文。
- **凭据不外泄**：响应与注入脚本都不含 access/refresh，已有测试断言；模型补丁的确认签名不是密钥。
- **输入与资源上限**：图片 prompt 白名单键、usage 256 KiB、catalog 4 MiB、image 20 MiB、codex.json 4 KiB 加严格单键版本正则；各解析函数均有类型与边界校验，循环与 `repeat` 有界。
- **并发与清理**：图片队列按账号串行且 gate 必释放、dispose 会 drain；额度服务用 generation/epoch 校验并在卸载时中止；管理端单 attempt 互斥。

## 验证记录

- `npm run check`、`npm run build` 通过。
- `DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test`：185 项，184 通过、0 失败、1 跳过（打包测试按约定单独运行）。
- `DSH_PACK_TEST=1 node --disable-warning=ExperimentalWarning --experimental-strip-types --test tests/packed-codex-config.test.ts`：1 项通过。
- 新增测试 5 项：管理面登录超时与恢复（[management.test.ts](<../tests/management.test.ts>)）、客户端轮询退避与超时提示（[client.test.ts](<../tests/client.test.ts>)）、base64 规范尾部（[image-api.test.ts](<../tests/image-api.test.ts>)）、并发目录合并（[model-patches.test.ts](<../tests/model-patches.test.ts>)）。

## 未覆盖与边界

- 未做真实账号登录、真实图片端点与真实 GUI 验收；超时、退避与超时文案只在替身流与模拟时钟上验证。
- 10 分钟上限是按「pi-ai 浏览器登录无自身期限」推断的产品取值，未在真实账号流程上评估慢速授权（多因素、账号切换）所需时间。
- 未改版本号、未改更新日志、未安装或重启任何 DSH；工作区改动要发布后才对已安装用户生效。

## 后续维护

- 处理 F4/F5 时保持所有拒绝路径 fail-closed，并为每个改动补充负向测试。
- 行为变化同步到 [README](../README.md)、[文档索引](README.md)；历史验证结论按维护约定冻结，不改写。
