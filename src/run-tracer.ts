import { randomUUID } from "node:crypto";
import {
  chatMessage,
  contentText,
  jsonAttribute,
  usageAttributes,
  type Message,
} from "./messages.js";
import type { LangfuseExporter } from "./langfuse-exporter.js";
import type { PluginHookContext, SpanData } from "./types.js";
import type { RequestContext, RunResult } from "./evaluation.js";

export const TRACE_HOOKS = [
  "llm_input",
  "model_call_started",
  "model_call_ended",
  "before_message_write",
  "before_tool_call",
  "after_tool_call",
  "llm_output",
  "agent_end",
] as const;
type Exporter = Pick<
  LangfuseExporter,
  "startSpan" | "patchOpenSpanAttributes" | "endSpanById"
> &
  Partial<Pick<LangfuseExporter, "getSpanContext">>;
type Attrs = SpanData["attributes"];
type Node = { id: string; start: number; end?: number; error?: string };
type Model = Node & {
  callId: string;
  outcome?: string;
  message?: Message;
  toolIds: Set<string>;
  step: Node;
};
type Tool = Node & { callId: string; finished: boolean };
type Run = {
  id: string;
  root: Node;
  rootStarted?: boolean;
  sessionKey: string;
  agentId: string;
  attrs: Attrs;
  requestContext?: RequestContext;
  history: Message[];
  systemPrompt?: string;
  toolDefinitions?: unknown;
  input: string;
  output?: string;
  attemptError?: string;
  models: Map<string, Model>;
  tools: Map<string, Tool>;
  failedToolResults: Map<string, { message: Message; at: number }>;
  steps: Node[];
  queue: Promise<void>;
  lastActivity: number;
  closing: boolean;
  contextReliable: boolean;
  awaitingModel: boolean;
};

/** One request-local state machine for the 2026.11.1 / 2026.11.5 hook contract.
 * before_message_write is synchronous; callbacks only enqueue observational
 * work and never return a hook mutation or a Promise to the host.
 */
export function createRunTracer(
  exporter: Exporter,
  options: {
    now?: () => number;
    openclawVersion?: string;
    requestContext?: (
      runId: string,
      sessionKey: string,
    ) => RequestContext | undefined;
    onRunFinished?: (runId: string, result: RunResult) => void;
    warn?: (message: string) => void;
    tags?: string[];
    userId?: string;
    toolAttributes?: (name: string, params: Record<string, unknown>) => Attrs;
  } = {},
) {
  const now = options.now ?? Date.now;
  const runs = new Map<string, Run>();
  const sessions = new Map<string, Set<Run>>();
  const seen = new Map<string, number>();
  let stopped = false;
  const id = () => randomUUID().replaceAll("-", "").slice(0, 16);
  const meta = (key: string, value: unknown): Attrs => ({
    [`langfuse.observation.metadata.${key}`]:
      typeof value === "string" ? value : jsonAttribute(value),
  });

  async function start(
    run: Run,
    node: Node,
    name: string,
    type: SpanData["type"],
    parent?: Node,
    attrs: Attrs = {},
  ) {
    await exporter.startSpan(
      {
        name,
        type,
        startTime: node.start,
        parentSpanId: parent?.id,
        ...(!parent && run.requestContext
          ? { remoteParent: run.requestContext.remoteParent }
          : {}),
        attributes: { ...run.attrs, ...attrs },
      },
      node.id,
    );
  }
  function end(node: Node, error?: string) {
    const problem = error ?? node.error;
    exporter.endSpanById(
      node.id,
      node.end ?? now(),
      problem
        ? {
            "langfuse.observation.level": "ERROR",
            "langfuse.observation.status_message": problem,
            "error.type": problem,
          }
        : undefined,
    );
  }
  function enqueue(run: Run, task: () => Promise<void> | void) {
    run.queue = run.queue.then(task).catch((error) => {
      run.contextReliable = false;
      options.warn?.(`[LangfuseTrace] Observation failed: ${String(error)}`);
    });
  }
  function input(run: Run): Message[] {
    return [
      ...(run.systemPrompt
        ? [{ role: "system", content: run.systemPrompt }]
        : []),
      ...run.history,
    ];
  }
  function cleanup(run: Run) {
    runs.delete(run.id);
    const group = sessions.get(run.sessionKey);
    group?.delete(run);
    if (!group?.size) sessions.delete(run.sessionKey);
    seen.set(run.id, now());
    while (seen.size > 1000) seen.delete(seen.keys().next().value!);
  }
  async function finish(run: Run, at: number, error?: string) {
    // Admission failures (for example an unknown tool name) can produce a
    // toolResult without before/after_tool_call. Wait until the run ends so
    // real hooks, including delayed hooks, always take precedence.
    let unattributedToolErrors = 0;
    for (const [callId, result] of run.failedToolResults) {
      if (run.tools.has(callId)) continue;
      const matches = [...run.models.values()].flatMap((model) =>
        (Array.isArray(model.message?.content) ? model.message.content : [])
          .filter(
            (part: Message) => part.type === "toolCall" && part.id === callId,
          )
          .map((call: Message) => ({ model, call })),
      );
      if (
        matches.length !== 1 ||
        (result.message.toolName &&
          result.message.toolName !== matches[0].call.name)
      ) {
        unattributedToolErrors++;
        continue;
      }
      const { model, call } = matches[0];
      const tool: Tool = {
        id: id(),
        start: result.at,
        end: result.at,
        callId,
        finished: true,
        error: contentText(result.message.content) || "Tool call failed",
      };
      run.tools.set(callId, tool);
      await start(run, tool, call.name, "tool", model.step, {
        "langfuse.observation.input": jsonAttribute(call.arguments ?? {}),
        "langfuse.observation.output": jsonAttribute({
          content: result.message.content ?? [],
          ...(result.message.details !== undefined
            ? { details: result.message.details }
            : {}),
          isError: true,
        }),
        ...meta("toolCallId", callId),
        ...meta("captureSource", "tool-result-fallback"),
        ...meta("executionTimingAvailable", false),
      });
    }
    if (unattributedToolErrors)
      exporter.patchOpenSpanAttributes(
        run.root.id,
        meta("unattributedToolErrors", unattributedToolErrors),
      );
    for (const model of run.models.values()) {
      if (!model.message)
        exporter.patchOpenSpanAttributes(
          model.id,
          meta(
            "outputUnavailable",
            "No unambiguous assistant message for this provider call",
          ),
        );
      if (model.end === undefined)
        model.error ??= error ?? "Missing model terminal hook";
      end(model);
    }
    for (const tool of [...run.tools.values()].reverse())
      end(
        tool,
        !tool.finished ? (error ?? "Missing tool terminal hook") : undefined,
      );
    for (const step of run.steps) {
      step.end ??= at;
      end(step);
    }
    exporter.patchOpenSpanAttributes(run.root.id, {
      "langfuse.observation.input": jsonAttribute(run.input),
      ...(run.output !== undefined
        ? { "langfuse.observation.output": jsonAttribute(run.output) }
        : {}),
      ...(!run.contextReliable ? meta("contextIncomplete", true) : {}),
    });
    run.root.end = at;
    const observationId = exporter.getSpanContext?.(run.root.id)?.spanId;
    end(run.root, error);
    cleanup(run);
    options.onRunFinished?.(run.id, {
      output: run.output,
      error:
        error ??
        (run.requestContext && !observationId
          ? "Agent observation could not be created"
          : undefined),
      observationId,
    });
  }

  async function process(run: Run, name: string, event: Message, at: number) {
    if (name === "llm_input") {
      // A new llm_input can also reset context after compaction/fallback.
      run.awaitingModel = true;
      run.output = undefined;
      run.attemptError = undefined;
      run.systemPrompt = event.systemPrompt;
      run.toolDefinitions = event.tools;
      run.history = (event.historyMessages ?? [])
        .filter((m: Message) => !m.excludeFromContext)
        .map(chatMessage);
      run.history.push({ role: "user", content: event.prompt });
      if (!run.rootStarted) {
        run.rootStarted = true;
        await start(run, run.root, "invoke_agent", "agent", undefined, {
          "langfuse.observation.input": jsonAttribute(run.input),
        });
      }
      return;
    }
    if (name === "model_call_started") {
      if (!event.callId || run.models.has(event.callId)) return;
      run.awaitingModel = false;
      const previous = run.steps.at(-1);
      if (previous) previous.end = at;
      const step: Node = { id: id(), start: at };
      run.steps.push(step);
      await start(
        run,
        step,
        "react_step",
        "step",
        run.root,
        meta("round", run.steps.length),
      );
      const model: Model = {
        id: id(),
        start: at,
        callId: event.callId,
        toolIds: new Set(),
        step,
      };
      run.models.set(event.callId, model);
      await start(run, model, "model_call", "model", step, {
        "langfuse.observation.model.name": event.model,
        "gen_ai.request.model": event.model,
        "gen_ai.provider.name": event.provider,
        ...meta("callId", event.callId),
        ...meta("round", run.steps.length),
        ...meta("inputSource", "openclaw-hooks-reconstructed"),
        ...(run.contextReliable
          ? { "langfuse.observation.input": jsonAttribute(input(run)) }
          : meta("inputUnavailable", "Ambiguous session message ownership")),
        ...(run.toolDefinitions
          ? meta("preparedToolDefinitions", run.toolDefinitions)
          : {}),
      });
    } else if (name === "model_call_ended") {
      const model = run.models.get(event.callId);
      if (!model || model.end !== undefined) return;
      model.outcome = event.outcome;
      model.end = at;
      // Host duration is measured around the provider request, unlike the
      // assistant timestamp (which can mark message creation before streaming).
      if (Number.isFinite(event.durationMs) && event.durationMs >= 0) {
        model.end = model.start + event.durationMs;
        exporter.patchOpenSpanAttributes(
          model.id,
          meta("durationMs", event.durationMs),
        );
      }
      if (event.outcome !== "completed")
        model.error = event.errorCategory ?? event.outcome ?? "Model failed";
    } else if (name === "before_message_write") {
      const message = event.message;
      if (!message || message.excludeFromContext) return;
      // The queued user message can be persisted after llm_input. That hook
      // already supplied the prepared prompt; do not append the raw copy.
      if (message.role === "user" && run.awaitingModel) return;
      if (message.role === "assistant") {
        const failed = ["error", "aborted"].includes(message.stopReason);
        const candidates = [...run.models.values()].filter(
          (m) =>
            !m.message &&
            (failed ? !!m.error || m.outcome === undefined : !m.error),
        );
        if (candidates.length === 1) {
          const model = candidates[0];
          model.message = message;
          const rendered = chatMessage(message);
          for (const call of rendered.tool_calls ?? [])
            model.toolIds.add(call.id);
          exporter.patchOpenSpanAttributes(model.id, {
            "langfuse.observation.output": jsonAttribute([rendered]),
            ...usageAttributes(message.usage),
            ...(message.usage?.cost?.total !== undefined
              ? {
                  "langfuse.observation.cost_details": jsonAttribute({
                    total: message.usage.cost.total,
                  }),
                }
              : {}),
            ...meta("stopReason", message.stopReason ?? "unknown"),
          });
          if (failed)
            model.error ??= message.errorMessage ?? message.stopReason;
        } else {
          run.contextReliable = false;
        }
      }
      if (
        message.role === "toolResult" &&
        message.isError === true &&
        typeof message.toolCallId === "string" &&
        message.toolCallId &&
        !run.failedToolResults.has(message.toolCallId)
      ) {
        run.failedToolResults.set(message.toolCallId, { message, at });
      }
      run.history.push(chatMessage(message));
    } else if (name === "before_tool_call") {
      if (!event.toolCallId || run.tools.has(event.toolCallId)) return;
      const nested = [...run.tools.values()]
        .filter(
          (t) =>
            !t.finished &&
            event.toolCallId.startsWith(`tool_call:${t.callId}:`),
        )
        .sort((a, b) => b.callId.length - a.callId.length)[0];
      const model = [...run.models.values()].find((m) =>
        m.toolIds.has(event.toolCallId),
      );
      const parent = nested ?? model?.step ?? run.steps.at(-1) ?? run.root;
      const tool: Tool = {
        id: id(),
        start: at,
        callId: event.toolCallId,
        finished: false,
      };
      run.tools.set(event.toolCallId, tool);
      await start(run, tool, event.toolName, "tool", parent, {
        "langfuse.observation.input": jsonAttribute(event.params),
        ...meta("toolCallId", event.toolCallId),
        ...options.toolAttributes?.(event.toolName, event.params ?? {}),
      });
    } else if (name === "after_tool_call") {
      const tool = run.tools.get(event.toolCallId);
      if (!tool || tool.finished) return;
      tool.finished = true;
      tool.end = at;
      const result = event.result;
      const isError =
        !!event.error ||
        result?.isError === true ||
        result?.details?.status === "error";
      if (isError)
        tool.error = String(
          event.error ||
            result?.details?.error?.message ||
            contentText(result?.content) ||
            "Tool failed",
        );
      exporter.patchOpenSpanAttributes(tool.id, {
        "langfuse.observation.output": jsonAttribute(
          result ?? { error: tool.error ?? "No tool result" },
        ),
        ...(event.durationMs !== undefined
          ? meta("durationMs", event.durationMs)
          : {}),
      });
      // Tool results enter model history only through before_message_write.
      // In particular, nested Code Mode calls are not extra provider messages.
    } else if (name === "llm_output") {
      run.output = (event.assistantTexts ?? []).join("\n");
    } else if (name === "agent_end") {
      if (!run.output) {
        const assistant = [...(event.messages ?? [])]
          .reverse()
          .find((m) => m.role === "assistant");
        if (assistant) run.output = contentText(assistant.content);
      }
      // agent_end closes an attempt, not the outer retry/fallback loop.
      run.attemptError =
        event.success === false ? (event.error ?? "Agent failed") : undefined;
    }
  }

  function handle(
    name: string,
    event: Message,
    context: PluginHookContext = {},
  ) {
    if (stopped) return;
    const at = now();
    // Prepared tools can contain executable callbacks after runtime caching.
    // Snapshot only serializable observation data, never retain host functions.
    const snapshot = JSON.parse(
      JSON.stringify(event, (_key, value) =>
        typeof value === "bigint"
          ? String(value)
          : value instanceof Error
            ? { message: value.message, name: value.name }
            : value,
      ),
    );
    const runId = event.runId ?? context.runId;
    let run = typeof runId === "string" ? runs.get(runId) : undefined;
    if (
      name === "llm_input" &&
      !run &&
      typeof runId === "string" &&
      !seen.has(runId)
    ) {
      const sessionKey = String(context.sessionKey ?? event.sessionId ?? runId);
      const requestContext = options.requestContext?.(runId, sessionKey);
      run = {
        id: runId,
        root: { id: id(), start: at },
        agentId: String(context.agentId ?? "main"),
        sessionKey,
        requestContext,
        attrs: {
          ...requestContext?.attributes,
          "langfuse.session.id": String(event.sessionId ?? sessionKey),
          "openclaw.run.id": runId,
          ...(options.openclawVersion
            ? { "openclaw.version": options.openclawVersion }
            : {}),
          ...meta("runId", runId),
          ...meta("agentId", context.agentId ?? "main"),
          ...(options.userId ? { "langfuse.user.id": options.userId } : {}),
          ...(options.tags?.length
            ? { "langfuse.trace.tags": jsonAttribute(options.tags) }
            : {}),
        },
        history: [],
        input: event.prompt ?? "",
        models: new Map(),
        tools: new Map(),
        failedToolResults: new Map(),
        steps: [],
        queue: Promise.resolve(),
        lastActivity: at,
        closing: false,
        contextReliable: true,
        awaitingModel: true,
      };
      runs.set(runId, run);
      if (!sessions.has(sessionKey)) sessions.set(sessionKey, new Set());
      sessions.get(sessionKey)!.add(run);
    }
    if (name === "before_message_write" && !run) {
      const group = [
        ...(sessions.get(String(context.sessionKey)) ?? []),
      ].filter((r) => !r.closing);
      if (group.length === 1) run = group[0];
      else if (group.length > 1)
        for (const candidate of group) candidate.contextReliable = false;
    }
    if (!run || run.closing) return;
    run.lastActivity = at;
    const current = run;
    enqueue(current, () => process(current, name, snapshot, at));
  }
  function handleAgentEvent(event: {
    runId: string;
    stream: string;
    data: Record<string, unknown>;
  }) {
    if (stopped || event.stream !== "lifecycle") return;
    const data = { ...event.data };
    if (
      data.executionSettled !== true ||
      (data.phase !== "end" && data.phase !== "error")
    )
      return;
    const run = runs.get(event.runId);
    if (!run || run.closing) return;
    run.closing = true;
    const at = now();
    enqueue(run, () => {
      const error =
        data.phase === "error" || data.aborted === true || !!data.error
          ? String(data.error || data.stopReason || "Agent failed")
          : run.attemptError;
      return finish(run, at, error);
    });
  }
  async function drain() {
    await Promise.all([...runs.values()].map((r) => r.queue));
  }
  async function sweep() {
    // Silence is not settlement: a model/tool can legitimately run for hours.
    await drain();
    for (const [key, at] of seen)
      if (now() - at > 20 * 60_000) seen.delete(key);
  }
  async function stop() {
    stopped = true;
    for (const run of runs.values())
      if (!run.closing) {
        run.closing = true;
        enqueue(run, () => finish(run, now(), "Gateway stopping"));
      }
    await drain();
  }
  return { handle, handleAgentEvent, drain, sweep, stop };
}
