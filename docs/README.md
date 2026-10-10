---
description: "区分 dsh-llm-chatgpt 当前使用指南、版本处理记录与历史实施方案。"
kind: "reference"
---

# 文档索引

## 概要

当前包版本为 `0.3.13`；发布状态以 [GitHub Release](<https://github.com/tanuki-cat/dsh-codex/releases/tag/v0.3.13>) 为准。安装、登录、模型补丁与账号额度以[项目 README](<../README.md>)和当前源码为准；版本记录保留对应实现的决策、验证与限制，不作为新版本的操作指南。

## 目录

- [当前使用与开发](#当前使用与开发)
- [版本处理与发布记录](#版本处理与发布记录)
- [历史方案与审查](#历史方案与审查)
- [维护约定](#维护约定)

## 当前使用与开发

- [安装与前置条件](<../README.md#安装>)：发布包、源码打包和本地安装脚本。
- [登录与缺失模型补丁](<../README.md#使用>)：预览、签名确认、原生目录恢复及失败处理。
- [Codex usage 命令](<../README.md#codex-usage-命令>)：5 小时与周剩余额度、主动查询和缓存提示。
- [Codex 5 小时额度条](<../README.md#codex-5-小时额度条>)：剩余显示、五分钟轮询、旧数据与显示条件。
- [usage 命令与剩余额度实施方案](<design-task-feature-codex-usage-command.md>)：双窗口查询、五分钟轮询及本次实施验收记录。
- [图片生成工具实施方案](<design-task-feature-codex-image-generation-tool.md>)：已实现首版；复用 ChatGPT 凭据、独立图片接口、附件展示及待完成的真实环境验收。
- [init 与内置版本配置实施方案](<design-task-feature-codex-init-and-version-config.md>)：原始实施基线；当前发布与用户验收反馈见 0.3.13 发布说明。
- [init 任务展示](<../README.md#项目规则-init-命令>)：当前源码复用宿主折叠通知，完整指令保留，旧历史不迁移；包含在正式版 `0.3.13`；用户已报告测试完成，验收边界见发布说明。
- [验证范围](<../README.md#验证范围>)：自动化测试、宿主集成及真实环境验收边界。
- [更新日志](<../CHANGELOG.md>)：版本功能和对应验证记录。

## 版本处理与发布记录

| 文档 | 对应版本与用途 |
| --- | --- |
| [init 与独立版本配置发布说明](<design-task-release-codex-init-0.3.13.md>) | 0.3.13 的发布内容、安装步骤、用户反馈和自动化验证边界。 |
| [模型补丁审查处理记录](<design-task-fix-codex-model-patch-review-0.3.9.md>) | 0.3.9 的逐项修复、风险缓解与未验证项；替代 0.3.8 方案作为该版本处理依据。 |
| [5 小时额度条发布说明](<design-task-release-codex-five-hour-usage-0.3.10.md>) | 0.3.10 的发布内容、GUI 样例和已执行/未执行验收。 |
| [usage 命令与卡片发布说明](<design-task-release-codex-usage-0.3.11.md>) | 0.3.11 的双窗口命令、剩余三色进度、五分钟轮询和验证边界。 |

## 历史方案与审查

下列文档保留原方案及其实施证据。计划内容不等于已实现接口；优先看各文档的状态、实际实施记录和对应版本处理结果。

| 文档 | 阅读边界 |
| --- | --- |
| [ChatGPT 订阅接入](<design-task-add-chatgpt-subscription-plugin.md>) | 0.2.x 自建 `chatgpt-plan` provider 的实现与排障；该路由不属于当前插件。 |
| [插件内 Codex 登录方案](<design-task-openai-codex-in-plugin-login.md>) | 登录入口的历史方案和实施记录；阶段二代写路由未实施，当前由宿主模型页添加路由。 |
| [缺失模型补丁方案](<design-task-feature-codex-missing-model-patches.md>) | 0.3.8 及此前的设计与账号实测；刷新、恢复、版本选择和确认行为见 0.3.9 处理记录。 |
| [0.3.8 缺陷与风险审查](<dsh-codex-0.3.8-code-review.md>) | 原审查意见，不代表每项风险已证实或当前仍存在；逐项状态见 0.3.9 处理记录。 |
| [5 小时额度条实施方案](<design-task-feature-codex-five-hour-usage-bar.md>) | 0.3.10 开发版方案与 dev.4 实施记录；正式版本边界见 0.3.10 发布说明。 |

## 维护约定

- 更新当前指南时先核对[包配置](<../package.json>)、[服务端入口](<../src/index.ts>)、[设置页客户端](<../src/client.ts>)和对应测试。
- 已完成的设计/验收记录保持冻结；后续行为改变写入当前指南或新增后续记录，交叉链接，不改写历史验证结论。
- 区分替身测试、真实宿主集成、真实账号请求和真实 GUI 验收。文档中的历史测试数量、截图和环境路径不表示本次执行结果或跨平台保证。
