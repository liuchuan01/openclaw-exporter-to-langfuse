# VSE 服务端接入示例

此目录是调用方示例，不是插件运行依赖。Node 24.19.0 验证；在该目录执行 `npm ci --ignore-scripts` 安装锁定的示例依赖。VSE 正式接入时将依赖合并到其服务端工程，不要把密钥或 SDK 初始化放在浏览器组件。

`gateway.call(method, params)` 代表已经完成 OpenClaw WebSocket Gateway 鉴权的客户端，要求 `operator.write`。不要把下面的 RPC 直接发到普通 `/v1/chat/completions`。先调用 prepare 登记上下文，再用返回的参数调用原生 `agent`。第三方插件不代发原生请求。插件启用 `evaluationEnabled: true` 后注册 `langfuse.agent.prepare` 与 `langfuse.agent.result`。

```js
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { evaluationRequest, executeEvaluation } from "./task.mjs";

// 从服务端环境变量读取 LANGFUSE_PUBLIC_KEY / SECRET_KEY / BASE_URL。
// 在执行器进程初始化一次；已有 OTel provider 时合并 processor，不要重复注册。
const processor = new LangfuseSpanProcessor();
const sdk = new NodeSDK({ spanProcessors: [processor] });
sdk.start();
const langfuse = new LangfuseClient();
const runMetadata = { run_code: "eval_20261124_001", knowledge_version: "kb_20261123" };

const result = await langfuse.experiment.run({
  name: "VSE OpenClaw regression",
  runName: runMetadata.run_code,
  metadata: runMetadata,
  data: snapshotItems, // VSE 固定版本题目：input、expectedOutput、metadata
  maxConcurrency: 2,
  task: async (item) => {
    const request = evaluationRequest(item, { ...runMetadata, ...item.metadata });
    await saveRequest(request); // VSE 持久化：由业务层实现
    const response = await executeEvaluation(gateway, request, {
      onAccepted: (accepted) => saveAccepted(request.request_id, accepted),
    });
    await saveResult(request.request_id, response);
    return response.output;
  },
});
await processor.forceFlush();
console.log(result.experimentId, result.experimentUrl);
// 常驻服务只在进程退出时调用；一次性任务可在这里关闭。
await sdk.shutdown();
```

`gateway`、`snapshotItems`、`saveRequest`、`saveAccepted`、`saveResult` 是 VSE 业务层需要提供的适配，不是 SDK 自带变量。完整可执行联调由维护者在隔离 Gateway 上完成，结果见仓库 VALIDATION.md。

`task.mjs` 使用 SDK 的公开 `getPropagatedAttributesFromContext` 读取当前实验身份，不自行拼造 experiment/item ID。标准答案不传给 Agent。示例 metadata 要求扁平标量；复杂对象应在 VSE 侧明确选择需要传播的字段。

本版 local data 的 item ID 由 SDK 默认按输入生成：重复输入可能得到同一 item ID。VSE 正式接入时须明确重复题目的语义，不能假定不同 metadata 会产生不同 item ID。需要区别同文不同题时，应在 SDK 的结构化 input 中包含稳定题目编码，并在 task 中单独取出问题文本传给 Agent；用实验条目回读验证区分结果。
