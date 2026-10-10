# Repository Guidelines

## 项目结构

本仓库是 DSH 的 `dsh-llm-chatgpt` 插件：扩展 ChatGPT 登录、模型目录、额度查询、图片工具和会话命令，聊天 OAuth 与推理协议由宿主 pi-ai 提供，不在此重复实现。

- [src/](<src/>)：服务端插件、模型目录与工具服务，以及 Web 客户端贡献；入口为 [index.ts](<src/index.ts>)、[client.ts](<src/client.ts>)。
- [config/codex.json](<config/codex.json>)：随包分发的模型目录请求版本配置，不是用户 profile 设置或 CLI 升级入口。
- [tests/](<tests/>)：Node 内建测试与已安装宿主集成；[scripts/](<scripts/>)：手工安装和排障脚本，调用前确认副作用。
- [docs/README.md](<docs/README.md>)：文档索引；使用说明以[README.md](<README.md>)和当前源码为准。历史方案不代替当前验收。

## 构建与开发

使用 Node `^22.19.0 || >=24.0.0` 和 npm；命令定义见[package.json](<package.json>)。

- `npm run check`：严格检查源码、脚本及构建配置，不覆盖测试文件。
- `npm run build`：tsdown 生成服务端 ESM 与客户端 IIFE。构建不会更新运行中的 DSH 插件。
- `npm test`：先构建，再运行全部测试；日常改动优先针对性验证。
- `npm pack`：先执行类型检查和构建，再生成安装包。

[lib/](<lib/>)是生成目录，不手写或提交产物；依赖、缓存和安装包亦由[忽略配置](<.gitignore>)排除。

## 编码风格

遵循现有 TypeScript ESM 写法：两空格缩进、单引号、通常省略分号，标识符和注释使用英文，文档及提交说明使用简体中文。遵守[tsconfig.json](<tsconfig.json>)的 NodeNext、strict 设置，源码相对模块导入沿用 `.js` 后缀。保留客户端 `__ModuleLoader__.load` factory 协议；客户端可见文案维护中英文映射。避免无关重构及重复实现宿主能力。

## 测试

测试命名为 `tests/*.test.ts`，使用 `node:test` 与 `node:assert/strict`。例如先构建，再运行：

```sh
node --disable-warning=ExperimentalWarning --experimental-strip-types --test tests/init-command.test.ts
```

宿主集成需设置 `DSH_INSTALL_ROOT` 为实际安装目录；未设置导致的 skip 不能算通过。测试优先使用临时目录、网络替身和明确的异步 barrier，避免真实凭据、共享状态和固定 sleep。修改鉴权或异步操作时覆盖取消、卸载、冲突和错误脱敏。

[打包测试](<tests/packed-codex-config.test.ts>)会触发 prepack 重建，须等待其它构建与测试结束后独立运行：

```sh
DSH_PACK_TEST=1 node --disable-warning=ExperimentalWarning --experimental-strip-types --test tests/packed-codex-config.test.ts
```

模拟网络或脚本化模型通过不证明真实账号、GUI 或自主模型行为；报告实际执行结果及未覆盖项。

## 提交与安全

近期提交采用 Conventional Commits 前缀，如 `feat:`、`fix:`、`docs:`、`refactor:`，后接简体中文说明。提交前检查范围与差异，不夹带生成文件或无关变更；版本变更同步清单、锁文件与当前说明。

不得提交 OAuth token、账号敏感信息、环境配置或真实凭据。保持管理接口 capability 校验与错误脱敏；不将内部异常原文发送给客户端。安装脚本会修改 profile，重启、安装、真实账号请求及发布均需单独授权，不以源码构建成功声称部署或真实环境验收完成。
