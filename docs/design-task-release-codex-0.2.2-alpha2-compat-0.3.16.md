---
description: "0.3.16 的 DSH 0.2.1-rc.2 至 rc.4 与 0.2.2-alpha.2 兼容声明、工具执行器适配、安装说明与验证边界。"
kind: "reference"
---

# 0.3.16 发布说明

## 概要

正式版 `0.3.16` 把声明的宿主版本从 `0.2.1-rc.1` 扩展到 `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4` 与 `0.2.2-alpha.2`，并修复宿主集成测试在 Node 24 上的解析递归。支持的旧宿主保持不变：`0.2.1-alpha.1`、`0.2.1-alpha.2` 与 `0.2.1-rc.1`；`0.2.0-rc.2` 仍只出现在授权与凭据两个包的声明里，宿主自身的兼容检查会以工具类包的范围拒绝它，与 `0.3.15` 相同。发布渠道为 GitHub Release，不发布 npm；本次不自动安装或重启现有 DSH。

## 目录

- [兼容声明](#兼容声明)
- [宿主变化与插件行为](#宿主变化与插件行为)
- [安装与升级](#安装与升级)
- [验证与限制](#验证与限制)

## 兼容声明

- `peerDependencies` 中 `@deepseek-ai/dsh-authorization`、`dsh-credentials`、`dsh-tools`、`dsh-attachment` 与 `dsh-llm` 都增加 `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4` 与 `0.2.2-alpha.2`，[安装脚本](../scripts/install-local.ts)的接受版本与[对应测试](<../tests/install-local.test.ts>)同步。
- DSH 的 `dsh plugin` 兼容检查按运行中的 `dsh` 版本比对全部 `@deepseek-ai/dsh*` peer 条目（见宿主 `evaluatePluginCompatibility`）。此前这些条目止于 `0.2.1-rc.1`，插件在 rc.2 及之后会被判定不兼容并要求逐版本豁免；声明后不再是问题。
- 开发依赖与类型核对基线升级到 `0.2.2-alpha.2`；`npm run check` 在该代类型上通过，插件用到的宿主导入（`dsh-tools` 的 `ToolRuntime`/`ToolRunContext`、`dsh-attachment`、`dsh-llm`、`dsh-authorization`、`dsh-credentials`）没有删除或改签名。
- 登录信任来源无需改动：`0.2.1-rc.2` 起与 `0.2.1-alpha.2` 同属 `webStartup` 加监听地址本身这一代，插件仍按请求读取现存来源，不把任一来源声明为注入依赖。

## 宿主变化与插件行为

- **工具呈现改为执行器插件**：`0.2.2-alpha.2` 从 `ToolRuntime` 移除了 `mode` 配置，改为把 native/PTC 呈现做成独立执行器插件（`dsh-tool-executor-native`、`dsh-tool-executor-ptc`），由宿主装配挂载。保留的 `mode` 键在该代校验为 `never`，传入它会让工具注册所在 fiber 保持不激活，表现为 `ctx.tools` 不存在而非报错。插件只调用 `tools.register`，不读写呈现配置，因此无需改动；受影响的是复用 `ToolRuntime` 的测试装配。
- **单次调用改为批量契约**：`ToolsService.execute` 在 `0.2.2-alpha.2` 收 `{ calls, agent, signal }` 并返回 `{ results, additionalContexts, concluded }`，不再接受 `{ name, arguments, callId }`。插件生产代码不直接调用 `execute`，只有宿主集成测试需要按代切换。
- **客户端资源解析**：该代 Chat 客户端通过 loader 的 `require.asset` 解析打包图片 URL，[展示测试](<../tests/installed-init-presentation.test.ts>)的工厂替身补上该函数。

## 安装与升级

从 [v0.3.16 GitHub Release](<https://github.com/tanuki-cat/dsh-codex/releases/tag/v0.3.16>) 下载安装包，在下载目录执行：

```sh
dsh plugin --profile web add ./dsh-llm-chatgpt-0.3.16.tgz
```

安装前备份 profile 配置；安装后重启承载插件的原 DSH Web 进程并刷新页面。只刷新浏览器不会更新服务端插件。

从 `0.3.15` 升级不需要额外迁移：本版本不新增 profile 配置项，也不改变凭据、模型目录、额度或命令接口的字段。

## 验证与限制

发布前执行 `npm run check`、`npm run build` 与完整测试：

- 单测（`DSH_INSTALL_ROOT` 未设置）：185 项中 174 项通过、0 失败、11 项跳过（缺少已安装宿主）。
- 宿主集成（在临时目录中逐代真实安装 `@deepseek-ai/dsh` 后以 `DSH_INSTALL_ROOT` 指向）：`0.2.1-alpha.1` 与 `0.2.1-alpha.2` 为 184 项通过、1 项跳过；`0.2.1-rc.1` 至 `0.2.1-rc.4` 与 `0.2.2-alpha.2` 为 183 项通过、2 项跳过。全部 0 失败。跳过的两项是 11 项宿主集成中按约定单独运行的打包测试，以及 `0.2.1-rc.1` 起不再提供可加载 `dsh-client-ui-slots` 模块的 SlotCore 注册表测试。
- 同一 `0.2.2-alpha.2` 安装在 Node 22 与 Node 24 上各跑一次全量，结果一致。
- 以 `DSH_PACK_TEST=1` 单独执行[打包配置测试](<../tests/packed-codex-config.test.ts>)：1 项通过、0 失败、0 跳过。
- 真实 `dsh plugin` 安装：在隔离的 `DSH_HOME` 下各建一个 `web` profile，`0.3.16` 在 `0.2.2-alpha.2`（Homebrew 安装）与 `0.2.1-rc.4`（临时安装）上均安装成功；以同样方式安装 `0.3.15` 时 `0.2.2-alpha.2` 报告 requirements 不满足并回滚，说明本版本声明确实解除了该拒绝。

测试侧的两项适配不是插件行为变更：宿主解析钩子原先在 `resolve` 内调用 `require.resolve`，Node 24 会把它重新送进同一个钩子直到栈溢出，现改为把宿主 `package.json` 作为父路径交给内置解析器；`0.2.2-alpha.2` 的工具网关需要挂载执行器插件，测试按该代形态补上 `dsh-tool-executor-native`/`-ptc`。

未验证真实浏览器登录、真实账号模型推理、真实图片端点、跨平台 GUI 及其它未声明宿主版本。自动化通过不代替真实 GUI 验收。
