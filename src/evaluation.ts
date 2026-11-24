import { createHash, randomUUID } from "node:crypto";
import type { OpenClawPluginApi, SpanData } from "./types.js";

export type RequestContext = {
  remoteParent: NonNullable<SpanData["remoteParent"]>;
  attributes: SpanData["attributes"];
};
export type RunResult = {
  output?: string;
  error?: string;
  observationId?: string;
};
type EvaluationRequest = {
  request_id: string;
  agent_id: string;
  message: string;
  observability: RequestContext;
};
type RecordEntry = {
  request: EvaluationRequest;
  fingerprint: string;
  runId: string;
  sessionKey: string;
  createdAt: number;
  endedAt?: number;
  claimed: boolean;
  status: "prepared" | "running" | "completed" | "failed" | "unknown";
  result?: RunResult;
};
const EXPERIMENT_KEYS = new Set([
  "langfuse.experiment.id",
  "langfuse.experiment.name",
  "langfuse.experiment.dataset.id",
  "langfuse.experiment.item.id",
  "langfuse.experiment.item.root_observation_id",
  "langfuse.experiment.item.version",
  "langfuse.environment",
]);
const REQUIRED_KEYS = [
  "langfuse.experiment.id",
  "langfuse.experiment.name",
  "langfuse.experiment.item.id",
  "langfuse.experiment.item.root_observation_id",
];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, limit: number) {
  if (typeof value !== "string" || !value.trim() || value.length > limit)
    throw new Error(`Invalid ${name}`);
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("Unexpected request field");
}

/** Explicit JSON carrier: no prompt injection and no dependence on global OTel context. */
export function parseEvaluationRequest(value: unknown): EvaluationRequest {
  const raw = object(value);
  if (Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024)
    throw new Error("Evaluation request exceeds 128 KiB");
  keys(raw, ["request_id", "agent_id", "message", "observability"]);
  const requestId = string(raw.request_id, "request_id", 100);
  const agentId = string(raw.agent_id ?? "main", "agent_id", 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(requestId) || !/^[a-z0-9_-]+$/.test(agentId))
    throw new Error("Invalid request_id or agent_id characters");
  const carrier = object(raw.observability);
  keys(carrier, ["traceparent", "attributes"]);
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(01)$/.exec(
    string(carrier.traceparent, "sampled version-00 traceparent", 55),
  );
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2]))
    throw new Error("Expected a valid sampled version-00 traceparent");
  const attributes = object(carrier.attributes);
  if (Object.keys(attributes).length > 64)
    throw new Error("Too many attributes");
  const clean: SpanData["attributes"] = {};
  for (const key of Object.keys(attributes).sort()) {
    if (
      !EXPERIMENT_KEYS.has(key) &&
      !/^langfuse\.(experiment\.metadata|observation\.metadata)\.[a-zA-Z0-9_-]{1,64}$/.test(
        key,
      )
    )
      throw new Error(`Unsupported context attribute: ${key}`);
    const v = attributes[key];
    if (
      !(typeof v === "string" && v.length <= 4096) &&
      !(typeof v === "number" && Number.isFinite(v)) &&
      typeof v !== "boolean"
    )
      throw new Error(`Invalid scalar attribute: ${key}`);
    if (EXPERIMENT_KEYS.has(key)) string(v, key, 4096);
    if (
      /^langfuse\.observation\.metadata\.(runId|agentId|callId|round|toolCallId|contextIncomplete|captureSource|executionTimingAvailable|unattributedToolErrors)$/.test(
        key,
      )
    )
      throw new Error(`Reserved context attribute: ${key}`);
    clean[key] = v as string | number | boolean;
  }
  for (const key of REQUIRED_KEYS) string(clean[key], key, 4096);
  if (
    !/^[0-9a-f]{16}$/.test(String(clean[REQUIRED_KEYS[3]])) ||
    /^0+$/.test(String(clean[REQUIRED_KEYS[3]]))
  )
    throw new Error("Invalid experiment item root observation ID");
  return {
    request_id: requestId,
    agent_id: agentId,
    message: string(raw.message, "message", 64 * 1024),
    observability: {
      remoteParent: { traceId: match[1], spanId: match[2], traceFlags: 1 },
      attributes: clean,
    },
  };
}

/** Bind before native admission; look up by runId, never by timing or a shared session. */
export function createEvaluationBridge(
  options: { now?: () => number; maxEntries?: number } = {},
) {
  const now = options.now ?? Date.now;
  const entries = new Map<string, RecordEntry>();
  const byRun = new Map<string, RecordEntry>();
  let stopped = false;
  const view = (entry: RecordEntry) => ({
    request_id: entry.request.request_id,
    run_id: entry.runId,
    session_key: entry.sessionKey,
    trace_id: entry.request.observability.remoteParent.traceId,
    item_root_observation_id:
      entry.request.observability.attributes[REQUIRED_KEYS[3]],
    status: entry.status,
    ...(entry.result ?? {}),
  });
  function agentRequest(entry: RecordEntry) {
    return {
      agentId: entry.request.agent_id,
      sessionKey: entry.sessionKey,
      message: entry.request.message,
      idempotencyKey: entry.runId,
      deliver: false,
    };
  }
  function sweep() {
    for (const [key, entry] of entries) {
      if (
        entry.endedAt === undefined &&
        now() - entry.createdAt > 30 * 60_000 &&
        !entry.claimed
      ) {
        entry.status = "unknown";
        entry.result = {
          error:
            "No llm_input observed within 30 minutes; do not silently resubmit",
        };
        entry.endedAt = now();
      }
      if (entry.endedAt !== undefined && now() - entry.endedAt > 60 * 60_000) {
        entries.delete(key);
        byRun.delete(entry.runId);
      }
    }
  }
  return {
    prepare(raw: unknown) {
      if (stopped) throw new Error("Evaluation service is stopping");
      const request = parseEvaluationRequest(raw);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(request))
        .digest("hex");
      sweep();
      const previous = entries.get(request.request_id);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error(
            "request_id already belongs to different input or context",
          );
        return { ...view(previous), agent_request: agentRequest(previous) };
      }
      if (entries.size >= (options.maxEntries ?? 1000))
        throw new Error("Evaluation capacity reached");
      const runId = randomUUID();
      const entry: RecordEntry = {
        request,
        fingerprint,
        runId,
        sessionKey: `agent:${request.agent_id}:langfuse:${runId}`,
        createdAt: now(),
        claimed: false,
        status: "prepared",
      };
      entries.set(request.request_id, entry);
      byRun.set(runId, entry);
      return { ...view(entry), agent_request: agentRequest(entry) };
    },
    result(requestId: unknown) {
      sweep();
      const entry = entries.get(string(requestId, "request_id", 100));
      if (!entry)
        throw new Error(
          "Unknown or expired request_id (results are not durable across reloads)",
        );
      return view(entry);
    },
    claim(runId: string, sessionKey: string): RequestContext | undefined {
      const entry = byRun.get(runId);
      if (!entry || entry.claimed || entry.endedAt !== undefined)
        return undefined;
      if (entry.sessionKey !== sessionKey) {
        entry.status = "failed";
        entry.endedAt = now();
        entry.result = {
          error: "Host session identity differs from the submitted session",
        };
        return undefined;
      }
      entry.claimed = true;
      entry.status = "running";
      entry.result = undefined;
      return structuredClone(entry.request.observability);
    },
    finish(runId: string, result: RunResult) {
      const entry = byRun.get(runId);
      if (!entry || !entry.claimed || entry.endedAt !== undefined) return;
      entry.result = { ...result };
      entry.status = result.error ? "failed" : "completed";
      entry.endedAt = now();
    },
    sweep,
    stop() {
      stopped = true;
      entries.clear();
      byRun.clear();
    },
  };
}

export function registerEvaluationMethods(
  api: OpenClawPluginApi,
  bridge: ReturnType<typeof createEvaluationBridge>,
) {
  if (!api.registerGatewayMethod)
    throw new Error("Evaluation requires the OpenClaw Gateway plugin API");
  for (const [name, handler] of [
    [
      "langfuse.agent.prepare",
      (params: Record<string, unknown>) => bridge.prepare(params),
    ],
    [
      "langfuse.agent.result",
      (params: Record<string, unknown>) => {
        keys(params, ["request_id"]);
        return bridge.result(params.request_id);
      },
    ],
  ] as const) {
    api.registerGatewayMethod(
      name,
      async ({ params, respond }) => {
        try {
          respond(true, await handler(params));
        } catch (error) {
          respond(false, undefined, {
            code: "INVALID_REQUEST",
            message: String(error),
          });
        }
      },
      { scope: "operator.write" },
    );
  }
}
