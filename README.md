# openclaw-exporter-to-langfuse

基于阿里云 exporter 维护的 fork，**兼容声明为 OpenClaw 2026.11.1–2026.11.5，当前插件版本 0.2.2**。通过 OpenClaw 原生 hooks 采集每次 Agent 运行、每轮模型调用和工具调用，直接以 OTLP 上报 Langfuse。

实际验证版本为 2026.11.1 和 2026.11.5，中间版本未逐一运行验证。

不需要额外部署 Python 接收器，也不依赖 `.trajectory.jsonl` 或读取会话 SQLite。使用独立的 OpenTelemetry provider，不替换网关的全局 provider。

## 安装与离线交付

完整中文操作步骤见 **[INSTALLATION.md](./INSTALLATION.md)**，包含构建、离线交付、配置、授权、自检和升级说明。

| 交付物 | 内容 | 安装条件 |
| --- | --- | --- |
| GitHub 源码 ZIP / git checkout | TypeScript 源码、依赖锁文件 | 在联网构建机安装依赖并编译，不能直接当成可运行插件 |
| `openclaw-exporter-to-langfuse-0.2.2.tgz` | 编译产物和插件声明，不含 `node_modules` | 本地包安装仍可能需要访问 npm 下载依赖 |
| 按安装指南制作的 `openclaw-exporter-to-langfuse-0.2.2-offline.tar.gz` | 编译产物、完整生产依赖、配置说明和自检工具 | 目标机器无需访问 GitHub / npm；需已有 OpenClaw 2026.11.1 或 2026.11.5，并能访问 Langfuse |

离线安装链路：

```text
联网构建机：获取指定 commit → npm ci → 测试和编译 → 准备生产依赖 → 打包并生成校验和
    ↓ 拷贝 offline.tar.gz 和校验和文件
离线运行机：校验 → 解压至固定目录 → OpenClaw --link 安装
    → 配置 Langfuse → 授予会话访问权限 → 热重载 → 检查 8 个 hook → 验证真实 trace
```

上游 npm 包和阿里云 OSS 安装器不包含本 fork 的修改。不要使用它们来安装或更新本 fork。

<a id="installation"></a>

## Langfuse 配置

将下面的条目合并到运行网关所用的 `openclaw.json`，保留已有插件和配置。默认路径为 `~/.openclaw/openclaw.json`；自定义 profile/state 目录以实际部署为准。

```json
{
  "plugins": {
    "allow": ["openclaw-exporter-to-langfuse"],
    "entries": {
      "openclaw-exporter-to-langfuse": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "endpoint": "https://<你的-Langfuse-域名>/api/public/otel",
          "headers": { "Authorization": "Basic <base64-public-key-colon-secret-key>" },
          "serviceName": "openclaw-agent",
          "tags": ["openclaw"]
        }
      }
    }
  }
}
```

Authorization 使用 Langfuse **项目**的 Public Key 和 Secret Key，将 `public-key:secret-key` 整体 Base64 编码，再加 `Basic ` 前缀。endpoint 填到 `/api/public/otel` 即可，插件自动拼接 `/v1/traces`。

**`hooks.allowConversationAccess` 是宿主授权，与 `config` 同级，不能写到 `config` 里面。** 插件不能给自己授权，manifest 中的声明也不构成授权。安装指南中的 `install.sh` 由操作者运行，负责写入授权、热重载和自检。

缺少授权时可能仍显示 loaded/activated，但只有 5 个 hook，无法产生正常 trace。验收必须确认 **8 个 hook 全部注册且没有 blocked/error diagnostics**。热重载前先等当前 Agent 请求结束，避免截断运行中的 trace。

同一请求只启用一套 Langfuse tracing 插件，避免重复上报。

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

不存在的工具等失败尝试，即使没有普通工具 hook，也会从 `isError=true` 的 toolResult 补成 ERROR Tool 节点。必须在同一次运行中唯一匹配模型的 toolCallId 和工具名，保留原始参数、错误输出及所属 ReAct 轮次；正常 hook 优先，不重复创建节点。

补录节点带 `captureSource=tool-result-fallback` 和 `executionTimingAvailable=false`。起止时间相同，表示观察到失败结果的时刻，不代表测量过执行耗时。无法匹配的失败计入 Agent 的 `unattributedToolErrors`，不猜测归属。本修复只影响新运行，不回填历史数据。

## 配置与范围

保留 `serviceName`、`tags`、`userId`、`debug`、`batchSize`、`flushIntervalMs`、`skillsRoots`、`skillTaggingEnabled`。不要配置 `enabledHooks`，采集所需生命周期事件必须一起启用。插件会采集对话原文、模型提供的 reasoning、工具参数及结果。

静态 tags 可以筛选 trace。**本分支尚未实现 Python SDK experiment 关联及请求级自定义 metadata 透传**；先验证原生 trace 结构，之后再接实验链路。Langfuse score 可关联已上报的 trace / observation ID。

开发验证使用 `npm test`，包含 Node 内置测试和 OpenTelemetry 内存 exporter 测试。实测结果见 [VALIDATION.md](./VALIDATION.md)。旧架构教程仅供历史参考，安装说明统一维护在 [INSTALLATION.md](./INSTALLATION.md)。
