# Codex 5 小时额度条：0.3.10 发布说明

## 概要

`dsh-llm-chatgpt 0.3.10` 在普通本机 Codex 会话的模型左侧增加账号共享的 5 小时额度条。不含周额度、不按会话 token 估算，不保证其他模型权限或限额可用。

发布渠道沿用 [GitHub Release v0.3.10](<https://github.com/tanuki-cat/dsh-codex/releases/tag/v0.3.10>)，不发布 npm。本文件描述发布内容与验证边界；远端发布状态以该 Release 为准。

## 使用

已登录并选择 `openai-codex` 后自动显示。悬浮或键盘聚焦查看已用、剩余、重置时间和刷新状态；点击检查受刷新间隔限制。未知额度显示 `—`，不伪装成 0%。远端 subagent 或无法确认路由时隐藏。

![浅色界面实屏样例](<assets/codex-five-hour-usage-light.png>)

![深色界面实屏样例](<assets/codex-five-hour-usage-dark.png>)

图片裁切自同源码开发版的原 GUI，仅展示当时真实百分比，不是当前账号额度。

## 安全与行为

- 复用宿主 OAuth 凭据，前端只收到清洗后的额度数据。管理接口校验 capability、Host/Origin，响应禁止缓存。
- 精确识别 18000 秒窗口，限制响应体和请求预算；账号级缓存、并发合并、失败退避。
- 账号变化、登录退出、隐藏或离线会使旧请求失效。旧数据最多保留五分钟、不跨重置，并标明状态。
- 不修改模型或账号配置，不影响切换模型、发送消息及原设置页登录。
- list 槽位用真实宿主要求的 id；独立数值进度语义位于按钮外，按钮名称包含百分比。

## 已执行验证

正式版本执行 `npm run check` 和 `DSH_INSTALL_ROOT=/opt/homebrew/lib/node_modules/@deepseek-ai/dsh npm test`：类型检查、构建、117 项测试通过，0 跳过，含真实 Host SlotCore 注册契约。

功能源码与已安装并验收的 `0.3.10-dev.4` 相同；正式版本仅调整版本和发布材料。开发版实测真实 usage 接口、原 GUI 展示、深浅色、键盘详情、900px 原生最窄窗口、隔夜重置，以及独立 AXProgressIndicator 数值和可访问按钮名称。历史过程见 [实施记录](<design-task-feature-codex-five-hour-usage-bar.md>)；其本机路径与缓存图片只属于历史验收环境，不是公共安装指引。

## 未覆盖与风险

- Desktop 最小窗口宽度为 900px，约 375px Web viewport 未做实屏验收。
- VoiceOver 全流程、更多展开控件组合、真实退出/换账号未执行；身份失效由确定性测试覆盖。
- usage 是私有后端 API，不承诺长期兼容；字段或权限变化时降级为未知额度。
- 真实 GUI 已验证宿主为 0.2.1-alpha.1，不宣布最低 GUI 兼容版本或全部平台兼容。
- 正式包不重复执行真实登录、改凭据或模型配置。

本次仅提交额度条相关源码、测试与发布材料；无关历史文档修改留在工作区。
