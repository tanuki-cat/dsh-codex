---
description: "0.3.15 的 DSH 0.2.1-rc.1 兼容声明、随版本发布的审查修复、安装说明与验证边界。"
kind: "reference"
---

# 0.3.15 发布说明

## 概要

正式版 `0.3.15` 把声明的宿主版本扩展到 DSH `0.2.1-rc.1`，并随版本发布 [0.3.14 代码审查](<dsh-codex-0.3.14-code-review.md>)中已完成、但尚未进入任何发布包的 F1–F3 修复。支持的旧宿主保持不变：`0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-alpha.2`。发布渠道为 GitHub Release，不发布 npm；本次不自动安装或重启现有 DSH。

## 目录

- [兼容声明](#兼容声明)
- [随版本发布的修复](#随版本发布的修复)
- [安装与升级](#安装与升级)
- [验证与限制](#验证与限制)

## 兼容声明

- `peerDependencies` 中 `@deepseek-ai/dsh-authorization`、`dsh-credentials`、`dsh-tools`、`dsh-attachment` 与 `dsh-llm` 都增加 `0.2.1-rc.1`，[安装脚本](../scripts/install-local.ts)的接受版本与[对应测试](<../tests/install-local.test.ts>)同步。
- DSH 的 `dsh plugin` 兼容检查按运行中的 `dsh` 版本比对 `peerDependencies` 的 `@deepseek-ai/dsh*` 条目。此前这些条目止于 `0.2.1-alpha.2`，在 `0.2.1-rc.1` 上会报告版本不兼容并要求逐版本豁免；声明后不再是问题。
- 登录信任来源无需改动：`0.2.1-rc.1` 与 `0.2.1-alpha.2` 同属 `webStartup` 加监听地址本身这一代，插件按请求读取现存来源，仍不把任一来源声明为注入依赖。
- 开发依赖与类型核对基线升级到 `0.2.1-rc.1`；`npm run check` 在 rc.1 类型上通过，插件用到的宿主导入没有删除或改签名。

## 随版本发布的修复

F1–F3 来自 [0.3.14 代码审查](<dsh-codex-0.3.14-code-review.md>)，方案、证据与实施细节以该文档为准，此处只列行为变化：

- F1 登录尝试上限：一次尝试最多 10 分钟，超时以 `errorKind: 'timeout'` 结束并恢复额度查询，卡片显示专用超时文案；等待期间状态轮询从固定 500 毫秒改为 0.5 秒起、最长 2 秒的退避。
- F2 图片响应内存：去掉整段 base64 再编码校验改为最终 quantum 的 padding 位判定，响应体从「分块列表 + `Buffer.concat`」改为单缓冲读取。判定语义等价，20 MiB 载荷的解码存活分配由 `external +46.7 MB` 降至 `+20.0 MB`。
- F3 目录预览并发合并：相同账号、access token 摘要与请求版本的并发预览共用一次远端请求，请求一结束即失效，因此「确认时重新拉取」的签名语义不变。

F4（单个畸形 `trustedHosts` 条目会让整条校验抛错）与 F5（IPv6 全零写法未识别为通配绑定）按审查结论保留为未处理建议，本版本未改动。

## 安装与升级

从 [v0.3.15 GitHub Release](<https://github.com/tanuki-cat/dsh-codex/releases/tag/v0.3.15>) 下载安装包，在下载目录执行：

```sh
dsh plugin --profile web add ./dsh-llm-chatgpt-0.3.15.tgz
```

安装前备份 profile 配置；安装后重启承载插件的原 DSH Web 进程并刷新页面。只刷新浏览器不会更新服务端插件。

从 `0.3.14` 升级不需要额外迁移：本版本不新增 profile 配置项，也不改变凭据、模型目录或额度接口的字段。

## 验证与限制

发布前执行 `npm run check`、`npm run build` 与完整测试：

- 单测（`DSH_INSTALL_ROOT` 未设置）：185 项中 174 项通过、0 失败、11 项跳过（缺少已安装宿主）。
- 真实已安装 DSH `0.2.1-rc.1`：185 项中 183 项通过、0 失败、2 项跳过（1 项按约定单独运行打包测试；1 项因该宿主不再提供可加载的 `dsh-client-ui-slots` 模块）。
- 以 `DSH_PACK_TEST=1` 单独执行[打包配置测试](<../tests/packed-codex-config.test.ts>)：1 项通过、0 失败、0 跳过。
- 真实 `dsh plugin` 安装：在隔离的 `DSH_HOME` 下用 `dsh plugin --profile web add` 安装打包产物，`0.3.15` 成功；以同样方式安装 `0.3.14` 时宿主报告 requirements 不满足并拒绝安装，说明本版本声明确实解除了该拒绝。

宿主集成测试的两处适配来自 rc.1 的客户端形态变化，不是插件行为变更：`0.2.1-rc.1` 只把 `SlotCore` 打进浏览器 bundle，安装根目录已无法解析 `@deepseek-ai/dsh-client-ui-slots`，原测试改为在该代宿主上跳过；其 Chat 客户端新增 `@tanstack/react-virtual` 模块级导入，[展示测试](<../tests/installed-init-presentation.test.ts>)为该依赖补了替身。

未验证真实浏览器登录、真实账号模型推理、真实图片端点、跨平台 GUI 及其它未声明宿主版本。自动化通过不代替真实 GUI 验收。
