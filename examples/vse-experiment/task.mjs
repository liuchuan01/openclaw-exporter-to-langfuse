import { context, trace } from "@opentelemetry/api";
import {
  getPropagatedAttributesFromContext,
  LANGFUSE_SDK_EXPERIMENT_ENVIRONMENT,
} from "@langfuse/core";
import { randomUUID } from "node:crypto";

// Call inside langfuse.experiment.run's task, never outside its active context.
export function evaluationRequest(item, metadata = {}, agentId = "main") {
  const active = context.active();
  const span = trace.getSpanContext(active);
  if (!span || !(span.traceFlags & 1))
    throw new Error("A sampled SDK task span is required");
  const propagated = getPropagatedAttributesFromContext(active);
  const attributes = {};
  for (const key of [
    "langfuse.experiment.id",
    "langfuse.experiment.name",
    "langfuse.experiment.dataset.id",
    "langfuse.experiment.item.id",
    "langfuse.experiment.item.root_observation_id",
    "langfuse.experiment.item.version",
  ]) {
    if (propagated[key] !== undefined) attributes[key] = propagated[key];
  }
  // SDK 6.1.1 uses a serialized metadata attribute. The plugin's explicit
  // carrier accepts scalar dotted attributes, so flatten it without guessing IDs.
  const experimentMetadata = propagated["langfuse.experiment.metadata"];
  if (experimentMetadata) {
    for (const [key, value] of Object.entries(JSON.parse(experimentMetadata)))
      attributes[`langfuse.experiment.metadata.${key}`] = value;
  }
  for (const [key, value] of Object.entries(metadata))
    attributes[`langfuse.observation.metadata.${key}`] = value;
  attributes["langfuse.environment"] = LANGFUSE_SDK_EXPERIMENT_ENVIRONMENT;
  return {
    request_id: randomUUID(),
    agent_id: agentId,
    message:
      typeof item.input === "string" ? item.input : JSON.stringify(item.input),
    observability: {
      traceparent: `00-${span.traceId}-${span.spanId}-01`,
      attributes,
    },
  };
}

// gateway.call must be an authenticated OpenClaw Gateway RPC client. Persist
// the request before submission: retry this SAME object after a transport error.
export async function executeEvaluation(
  gateway,
  request,
  { timeoutMs = 180_000, onAccepted = () => {} } = {},
) {
  let result = await gateway.call("langfuse.agent.prepare", request);
  await onAccepted(result); // Persist run/trace mapping before native admission.
  if (result.status === "prepared") {
    const accepted = await gateway.call("agent", result.agent_request);
    if (accepted.runId !== result.run_id)
      throw new Error(
        "Host returned a different runId; stop and reconcile this request",
      );
  }
  const deadline = Date.now() + timeoutMs;
  while (["prepared", "running", "unknown"].includes(result.status)) {
    if (Date.now() >= deadline)
      throw new Error(
        `Evaluation deadline exceeded; reconcile request_id=${request.request_id} before retrying`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    result = await gateway.call("langfuse.agent.result", {
      request_id: request.request_id,
    });
  }
  if (result.status !== "completed")
    throw new Error(result.error || "Agent failed");
  if (typeof result.output !== "string")
    throw new Error("Agent completed without an output");
  return result;
}
