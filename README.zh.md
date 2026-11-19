# openclaw-exporter-to-langfuse

[English](./README.md) | **中文**

基于阿里云 exporter 维护的 fork，**仅适配 OpenClaw 2026.11.5**。插件通过运行时 hooks 采集数据，直接以 OTLP 上报 Langfuse，不需要 Python 接收器、`.trajectory.jsonl` 或 SQLite 读取逻辑。

## 安装

```bash
git clone https://github.com/liuchuan01/openclaw-exporter-to-langfuse.git
cd openclaw-exporter-to-langfuse
git checkout feat/openclaw-2026-11-5
npm ci
npm test
npm pack
openclaw plugins install ./openclaw-exporter-to-langfuse-0.2.0.tgz
```

参考 [英文 README 的配置示例](./README.md#installation)，配置 endpoint、Authorization 和 `hooks.allowConversationAccess`，重启 Gateway。将配置合并进现有 plugins 设置，保留其他插件。上游 npm 包和 OSS 安装脚本不包含本 fork 的改动。同一请求仅启用一个 Langfuse tracing 插件，避免重复上报。

## 上报结构

```text
invoke_agent（AGENT，每个 runId 一条 trace）
├─ react_step（本轮分组）
│  ├─ model_call（GENERATION）
│  └─ exec（TOOL）
│     └─ read（Code Mode 内部工具）
└─ react_step
   └─ model_call（最终回答）
```

- Agent：问题、最终答案。
- Generation：带角色的累积上下文、模型回答、模型提供的 reasoning、工具调用、token 用量与耗时。
- Tool：参数、结果和错误内容；内部工具挂在外层工具下。
- ReAct 分组仅组织树结构，不重复存放输入输出。

模型耗时使用 `model_call_started` / `model_call_ended`，不再用消息创建时间推算。模型上下文从 `llm_input` 和后续消息累积重建，标记 `inputSource=openclaw-hooks-reconstructed`；并非供应商实际 HTTP 请求的逐字副本，供应商转换或未发事件的压缩可能造成差异。准备阶段工具定义存入 metadata。

内部工具的 `excludeFromContext` 消息不进入下一轮模型上下文。工具失败保留错误和输出；恢复成功的 Agent 不会整体标为失败。无法匹配输出的模型调用标记 `outputUnavailable`。

runId 隔离请求，session ID 关联会话。消息写入事件只有 sessionKey；同会话多个请求重叠、无法确定归属时，丢弃歧义消息并标记上下文不完整。缺失结束事件的运行在关闭服务或空闲 20 分钟后标为不完整并结束。

## 配置与范围

保留 `serviceName`、`tags`、`userId`、`debug`、`batchSize`、`flushIntervalMs`、`skillsRoots`、`skillTaggingEnabled`。不要配置 `enabledHooks`，采集所需生命周期事件必须一起启用。插件会采集对话原文、模型提供的 reasoning、工具参数及结果。

静态 tags 可以筛选 trace。**本分支尚未实现 Python SDK experiment 关联及请求级自定义 metadata 透传**；先验证原生 trace 结构，之后再接实验链路。Langfuse score 可关联已上报的 trace / observation ID。

开发验证使用 `npm test`，包含 Node 内置测试和 OpenTelemetry 内存 exporter 测试。实测结果见 [VALIDATION.md](./VALIDATION.md)。仓库保留的旧版架构及 OSS 部署文档仅供上游历史参考。
