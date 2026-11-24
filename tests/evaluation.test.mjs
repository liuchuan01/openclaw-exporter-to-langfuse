import test from "node:test";
import assert from "node:assert/strict";
import {
  createEvaluationBridge,
  parseEvaluationRequest,
  registerEvaluationMethods,
} from "../dist/evaluation.js";
import { createRunTracer } from "../dist/run-tracer.js";
import { LangfuseExporter } from "../dist/langfuse-exporter.js";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

function request(id = "q1", traceId = "1".repeat(32)) {
  return {
    request_id: id,
    agent_id: "main",
    message: "Read the fixture",
    observability: {
      traceparent: `00-${traceId}-${"a".repeat(16)}-01`,
      attributes: {
        "langfuse.experiment.id": "experiment-1",
        "langfuse.experiment.name": "regression",
        "langfuse.experiment.item.id": id,
        "langfuse.experiment.item.root_observation_id": "a".repeat(16),
        "langfuse.observation.metadata.run_code": "run-1",
        "langfuse.observation.metadata.knowledge_version": "kb-7",
      },
    },
  };
}

test("reject invalid trace context and non-whitelisted or oversized metadata before admission", () => {
  for (const change of [
    (r) =>
      (r.observability.traceparent = `00-${"0".repeat(32)}-${"a".repeat(16)}-01`),
    (r) =>
      (r.observability.traceparent = r.observability.traceparent.replace(
        /01$/,
        "00",
      )),
    (r) => delete r.observability.attributes["langfuse.experiment.id"],
    (r) =>
      (r.observability.attributes[
        "langfuse.experiment.item.root_observation_id"
      ] = "invalid"),
    (r) =>
      (r.observability.attributes["langfuse.observation.input"] = "overridden"),
    (r) =>
      (r.observability.attributes["langfuse.observation.metadata.runId"] =
        "foreign"),
    (r) =>
      (r.observability.attributes["langfuse.observation.metadata.x"] = {
        nested: true,
      }),
    (r) =>
      (r.observability.attributes["langfuse.observation.metadata.x"] =
        "x".repeat(4097)),
    (r) =>
      (r.observability.attributes["langfuse.observation.metadata.x"] = NaN),
    (r) => (r.session_key = "agent:main:existing"),
    (r) => (r.message = "x".repeat(65537)),
  ]) {
    const r = request();
    change(r);
    assert.throws(() => parseEvaluationRequest(r));
  }
});

test("prepare stable native admission parameters, reject request reuse, and isolate sessions", () => {
  const bridge = createEvaluationBridge();
  const first = bridge.prepare(request());
  assert.equal(first.status, "prepared");
  assert.deepEqual(bridge.prepare(request()), first);
  assert.throws(
    () => bridge.prepare({ ...request(), message: "different" }),
    /different/,
  );
  const second = bridge.prepare(request("q2", "2".repeat(32)));
  assert.notEqual(first.session_key, second.session_key);
  assert.deepEqual(Object.keys(first.agent_request).sort(), [
    "agentId",
    "deliver",
    "idempotencyKey",
    "message",
    "sessionKey",
  ]);
  assert.equal(first.agent_request.idempotencyKey, first.run_id);
  assert.equal(first.agent_request.message, request().message);
  assert.ok(bridge.claim(first.run_id, first.session_key));
  assert.equal(bridge.claim(first.run_id, first.session_key), undefined);
  bridge.finish(first.run_id, {
    output: "answer",
    observationId: "b".repeat(16),
  });
  assert.equal(bridge.result("q1").output, "answer");
  assert.equal(bridge.result("q2").status, "prepared");
});

test("re-preparation after lost admission response keeps the exact native idempotency key", () => {
  const bridge = createEvaluationBridge();
  const first = bridge.prepare(request());
  const retry = bridge.prepare(request());
  assert.deepEqual(first.agent_request, retry.agent_request);
  assert.ok(bridge.claim(first.run_id, first.session_key));
  assert.equal(bridge.prepare(request()).status, "running");
  bridge.finish(first.run_id, { output: "recovered" });
  assert.equal(bridge.result("q1").status, "completed");
});

test("session mismatch fails closed; capacity, expiry and shutdown are bounded", async () => {
  let clock = 1000;
  const bridge = createEvaluationBridge({ now: () => clock, maxEntries: 1 });
  const result = await bridge.prepare(request());
  assert.throws(() => bridge.prepare(request("q2")), /capacity/);
  assert.equal(bridge.claim(result.run_id, "agent:main:wrong"), undefined);
  assert.equal(bridge.result("q1").status, "failed");
  clock += 60 * 60_000 + 1;
  bridge.sweep();
  assert.throws(() => bridge.result("q1"), /expired/);
  await bridge.prepare(request("q2"));
  clock += 30 * 60_000 + 1;
  bridge.sweep();
  assert.equal(bridge.result("q2").status, "unknown");
  bridge.stop();
  assert.throws(() => bridge.prepare(request("q3")), /stopping/);
});

test("RPC registration requires gateway write authority and returns validation errors", async () => {
  const methods = new Map();
  const bridge = createEvaluationBridge();
  registerEvaluationMethods(
    {
      runtime: { gateway: {} },
      registerGatewayMethod(name, fn, opts) {
        assert.equal(opts.scope, "operator.write");
        methods.set(name, fn);
      },
    },
    bridge,
  );
  assert.deepEqual(
    [...methods.keys()],
    ["langfuse.agent.prepare", "langfuse.agent.result"],
  );
  let result;
  await methods.get("langfuse.agent.prepare")({
    params: {},
    respond: (...args) => (result = args),
  });
  assert.equal(result[0], false);
  assert.equal(result[2].code, "INVALID_REQUEST");
});

test("remote SDK root owns every experiment span; concurrent and ordinary traces stay isolated", async () => {
  const sink = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(sink)],
  });
  const exporter = new LangfuseExporter(
    { logger: { info() {}, error: assert.fail } },
    {},
  );
  exporter.provider = provider;
  exporter.tracer = provider.getTracer("test");
  exporter.initialized = true;
  const bridge = createEvaluationBridge();
  const a = await bridge.prepare(request("q1"));
  const b = await bridge.prepare(request("q2", "2".repeat(32)));
  const tracer = createRunTracer(exporter, {
    requestContext: bridge.claim,
    onRunFinished: bridge.finish,
    warn: assert.fail,
  });
  for (const r of [a, b, { run_id: "ordinary", session_key: "ordinary" }]) {
    const ctx = { runId: r.run_id, sessionKey: r.session_key };
    tracer.handle(
      "llm_input",
      { prompt: "question", historyMessages: [] },
      ctx,
    );
    if (r === a) {
      tracer.handle("model_call_started", { callId: "failed-attempt" }, ctx);
      tracer.handle(
        "model_call_ended",
        {
          callId: "failed-attempt",
          outcome: "error",
          errorCategory: "fetch failed",
        },
        ctx,
      );
      tracer.handle("llm_output", { assistantTexts: [] }, ctx);
      tracer.handle(
        "agent_end",
        { success: false, error: "fetch failed" },
        ctx,
      );
      await tracer.drain();
      assert.equal(bridge.result(r.request_id).status, "running");
      assert.equal(sink.getFinishedSpans().length, 0);
      tracer.handle(
        "llm_input",
        { prompt: "question", historyMessages: [] },
        ctx,
      );
    }
    tracer.handle("model_call_started", { callId: "model" }, ctx);
    tracer.handle(
      "model_call_ended",
      { callId: "model", outcome: "completed" },
      ctx,
    );
    tracer.handle(
      "before_message_write",
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "bad",
              name: "missing",
              arguments: { x: 1 },
            },
          ],
        },
      },
      ctx,
    );
    tracer.handle(
      "before_message_write",
      {
        message: {
          role: "toolResult",
          toolCallId: "bad",
          toolName: "missing",
          isError: true,
          content: [{ type: "text", text: "Tool missing not found" }],
        },
      },
      ctx,
    );
    tracer.handle("llm_output", { assistantTexts: ["answer"] }, ctx);
    tracer.handle("agent_end", { success: true }, ctx);
    tracer.handleAgentEvent({
      runId: ctx.runId,
      stream: "lifecycle",
      data: {
        phase: "end",
        executionSettled: true,
      },
    });
  }
  await tracer.stop();
  await exporter.flush();
  const spans = sink.getFinishedSpans();
  for (const [r, traceId] of [
    [a, "1".repeat(32)],
    [b, "2".repeat(32)],
  ]) {
    const group = spans.filter((s) => s.spanContext().traceId === traceId);
    assert.equal(group.length, r === a ? 6 : 4);
    const root = group.find((s) => s.name === "invoke_agent");
    assert.equal(root.parentSpanContext.spanId, "a".repeat(16));
    for (const span of group) {
      assert.equal(
        span.attributes["langfuse.experiment.item.id"],
        r.request_id,
      );
      assert.equal(
        span.attributes["langfuse.experiment.item.root_observation_id"],
        "a".repeat(16),
      );
      assert.equal(
        span.attributes["langfuse.observation.metadata.knowledge_version"],
        "kb-7",
      );
    }
    assert.equal(group.find((s) => s.name === "missing").status.code, 2);
    assert.equal(
      bridge.result(r.request_id).observationId,
      root.spanContext().spanId,
    );
    assert.equal(bridge.result(r.request_id).status, "completed");
  }
  const ordinary = spans.filter(
    (s) => s.attributes["openclaw.run.id"] === "ordinary",
  );
  assert.equal(ordinary.length, 4);
  assert.equal(
    ordinary.find((s) => s.name === "invoke_agent").parentSpanContext,
    undefined,
  );
  assert.ok(ordinary.every((s) => !s.attributes["langfuse.experiment.id"]));
  await exporter.dispose();
});

test("evaluation fails explicitly when the agent observation cannot be created", async () => {
  const bridge = createEvaluationBridge();
  const prepared = bridge.prepare(request());
  const tracer = createRunTracer(
    {
      async startSpan() {},
      patchOpenSpanAttributes() {},
      endSpanById() {},
    },
    { requestContext: bridge.claim, onRunFinished: bridge.finish },
  );
  const ctx = { runId: prepared.run_id, sessionKey: prepared.session_key };
  tracer.handle("llm_input", { prompt: "question", historyMessages: [] }, ctx);
  tracer.handle("agent_end", { success: true }, ctx);
  tracer.handleAgentEvent({
    runId: ctx.runId,
    stream: "lifecycle",
    data: {
      phase: "end",
      executionSettled: true,
    },
  });
  await tracer.stop();
  assert.equal(bridge.result("q1").status, "failed");
  assert.match(bridge.result("q1").error, /observation could not be created/);
});
