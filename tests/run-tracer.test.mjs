import test from "node:test";
import assert from "node:assert/strict";
import { createRunTracer } from "../dist/run-tracer.js";

function fixture() {
  const spans = new Map();
  let clock = 1000;
  const tracer = createRunTracer(
    {
      async startSpan(data, id) {
        assert.ok(!spans.has(id));
        spans.set(id, structuredClone(data));
      },
      patchOpenSpanAttributes(id, attrs) {
        Object.assign(spans.get(id).attributes, attrs);
      },
      endSpanById(id, end, attrs) {
        const span = spans.get(id);
        assert.equal(span.endTime, undefined);
        span.endTime = end;
        Object.assign(span.attributes, attrs);
      },
    },
    { now: () => clock, warn: (m) => assert.fail(m) },
  );
  const emit = (name, event = {}, runId = "run", sessionKey = runId) => {
    clock += 10;
    tracer.handle(name, event, { runId, sessionKey, agentId: "main" });
  };
  const message = (value, sessionKey = "run") =>
    emit("before_message_write", { message: value }, undefined, sessionKey);
  const start = (runId = "run", prompt = "question", sessionKey = runId) =>
    emit(
      "llm_input",
      { prompt, historyMessages: [], systemPrompt: "system" },
      runId,
      sessionKey,
    );
  const model = (callId) =>
    emit("model_call_started", {
      callId,
      model: "deepseek-chat",
      provider: "deepseek",
    });
  const completed = (callId) =>
    emit("model_call_ended", { callId, outcome: "completed", durationMs: 123 });
  return { spans, tracer, emit, message, start, model, completed };
}
const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  stopReason: "stop",
  ...extra,
});
const text = (value) => ({ type: "text", text: value });
const io = (span, key) =>
  JSON.parse(span.attributes[`langfuse.observation.${key}`]);

test("each ReAct round retains question, earlier results, and real provider duration", async () => {
  const f = fixture();
  f.start();
  for (let round = 1; round <= 3; round++) {
    f.model(`m${round}`);
    f.completed(`m${round}`);
    f.message(
      assistant([
        {
          type: "toolCall",
          id: `t${round}`,
          name: "read",
          arguments: { path: `${round}` },
        },
      ]),
    );
    f.emit("before_tool_call", {
      toolCallId: `t${round}`,
      toolName: "read",
      params: { path: `${round}` },
    });
    f.emit("after_tool_call", {
      toolCallId: `t${round}`,
      result: { content: [text(`value${round}`)] },
    });
    f.message({
      role: "toolResult",
      toolCallId: `t${round}`,
      content: [text(`value${round}`)],
    });
  }
  f.model("final");
  f.completed("final");
  f.message(assistant([text("answer")]));
  f.emit("llm_output", { assistantTexts: ["answer"] });
  f.emit("agent_end", { success: true });
  await f.tracer.drain();
  const models = [...f.spans.values()].filter((s) => s.type === "model");
  assert.equal(models.length, 4);
  assert.deepEqual(
    io(models[3], "input")
      .filter((m) => m.role === "tool")
      .map((m) => m.content),
    ["value1", "value2", "value3"],
  );
  assert.equal(io(models[3], "input")[1].content, "question");
  for (const span of models) assert.equal(span.endTime - span.startTime, 123);
  for (const span of f.spans.values()) assert.ok(span.endTime);
});

test("Code Mode nested tools have parents, errors, and no extra context messages", async () => {
  const f = fixture();
  f.start();
  f.model("m");
  f.completed("m");
  f.message(
    assistant([{ type: "toolCall", id: "outer", name: "exec", arguments: {} }]),
  );
  f.emit("before_tool_call", {
    toolCallId: "outer",
    toolName: "exec",
    params: {},
  });
  f.emit("before_tool_call", {
    toolCallId: "tool_call:outer:read:1",
    toolName: "read",
    params: { path: "missing" },
  });
  f.emit("after_tool_call", {
    toolCallId: "tool_call:outer:read:1",
    result: { details: { status: "error" }, content: [text("ENOENT")] },
  });
  f.message({
    role: "custom",
    excludeFromContext: true,
    content: "internal artifact",
  });
  f.emit("after_tool_call", {
    toolCallId: "outer",
    result: { content: [text("handled")] },
  });
  f.message({
    role: "toolResult",
    toolCallId: "outer",
    content: [text("handled")],
  });
  f.model("final");
  f.completed("final");
  f.message(assistant([text("recovered")]));
  f.emit("agent_end", { success: true });
  await f.tracer.drain();
  const [outerId] = [...f.spans].find(([, s]) => s.name === "exec");
  const nested = [...f.spans.values()].find((s) => s.name === "read");
  assert.equal(nested.parentSpanId, outerId);
  assert.equal(nested.attributes["langfuse.observation.level"], "ERROR");
  assert.equal(
    nested.attributes["langfuse.observation.status_message"],
    "ENOENT",
  );
  const final = [...f.spans.values()].filter((s) => s.type === "model")[1];
  assert.equal(io(final, "input").filter((m) => m.role === "tool").length, 1);
  assert.ok(!JSON.stringify(io(final, "input")).includes("internal artifact"));
  assert.equal([...f.spans.values()][0].attributes["error.type"], undefined);
});

test("concurrent runs never share spans even when tool IDs are identical", async () => {
  const f = fixture();
  f.start("a", "alpha");
  f.start("b", "beta");
  for (const run of ["a", "b"]) {
    f.emit(
      "before_tool_call",
      { toolCallId: "same", toolName: "read", params: { run } },
      run,
    );
    f.emit("after_tool_call", { toolCallId: "same", result: { run } }, run);
    f.emit("agent_end", { success: true }, run);
  }
  await f.tracer.drain();
  const tools = [...f.spans.values()].filter((s) => s.type === "tool");
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0].parentSpanId, tools[1].parentSpanId);
  for (const span of tools)
    assert.equal(io(span, "input").run, io(span, "output").run);
});

test("ambiguous session-only messages are discarded and context is marked incomplete", async () => {
  const f = fixture();
  f.start("a", "alpha", "shared");
  f.start("b", "beta", "shared");
  f.tracer.handle(
    "before_message_write",
    { message: assistant([text("private")]) },
    { sessionKey: "shared" },
  );
  for (const run of ["a", "b"])
    f.emit("agent_end", { success: true }, run, "shared");
  await f.tracer.drain();
  for (const span of f.spans.values()) {
    assert.equal(
      span.attributes["langfuse.observation.metadata.contextIncomplete"],
      "true",
    );
    assert.ok(!JSON.stringify(span).includes("private"));
  }
});

test("duplicate hooks are idempotent and shutdown closes incomplete runs", async () => {
  const f = fixture();
  f.start();
  f.start();
  f.model("m");
  f.model("m");
  f.emit("before_tool_call", { toolCallId: "t", toolName: "read", params: {} });
  await f.tracer.stop();
  assert.equal(
    [...f.spans.values()].filter((s) => s.type === "agent").length,
    1,
  );
  assert.equal(
    [...f.spans.values()].filter((s) => s.type === "model").length,
    1,
  );
  for (const s of f.spans.values()) assert.ok(s.endTime);
  assert.equal(
    [...f.spans.values()][0].attributes["langfuse.observation.status_message"],
    "Gateway stopping",
  );
});

test("failed provider retry stays an error while the recovered agent succeeds", async () => {
  const f = fixture();
  f.start();
  f.model("failed");
  f.emit("model_call_ended", {
    callId: "failed",
    outcome: "error",
    errorCategory: "rate_limit",
    durationMs: 5,
  });
  f.model("retry");
  f.completed("retry");
  f.message(assistant([text("ok")]));
  f.emit("agent_end", { success: true });
  await f.tracer.drain();
  const models = [...f.spans.values()].filter((s) => s.type === "model");
  assert.equal(models[0].attributes["error.type"], "rate_limit");
  assert.equal(models[0].attributes["langfuse.observation.output"], undefined);
  assert.equal(io(models[1], "output")[0].content, "ok");
});

test("session-only message hook resolves the sole active run", async () => {
  const f = fixture();
  f.start("unique", "question", "session");
  f.emit(
    "model_call_started",
    { callId: "m", model: "deepseek-chat" },
    "unique",
    "session",
  );
  f.emit(
    "model_call_ended",
    { callId: "m", outcome: "completed", durationMs: 200 },
    "unique",
    "session",
  );
  f.tracer.handle(
    "before_message_write",
    { message: assistant([text("session answer")]) },
    { sessionKey: "session" },
  );
  f.emit("agent_end", { success: true }, "unique", "session");
  await f.tracer.drain();
  const model = [...f.spans.values()].find((s) => s.type === "model");
  assert.equal(io(model, "output")[0].content, "session answer");
});

test("cached tool callbacks do not prevent capturing a later request", async () => {
  const f = fixture();
  f.emit("llm_input", {
    prompt: "question",
    historyMessages: [],
    tools: [{ name: "read", execute() {} }],
  });
  f.model("m");
  f.completed("m");
  f.message(assistant([text("answer")]));
  f.emit("agent_end", { success: true });
  await f.tracer.drain();
  const model = [...f.spans.values()].find((s) => s.type === "model");
  assert.deepEqual(
    JSON.parse(
      model.attributes["langfuse.observation.metadata.preparedToolDefinitions"],
    ),
    [{ name: "read" }],
  );
  assert.ok(model.parentSpanId);
});

test("optional not_found is not mislabeled as a failed tool", async () => {
  const f = fixture();
  f.start();
  f.emit("before_tool_call", {
    toolCallId: "t",
    toolName: "read",
    params: { optional: true },
  });
  f.emit("after_tool_call", {
    toolCallId: "t",
    result: { details: { status: "not_found", optional: true } },
  });
  f.emit("agent_end", { success: true });
  await f.tracer.drain();
  const tool = [...f.spans.values()].find((s) => s.type === "tool");
  assert.equal(tool.attributes["error.type"], undefined);
});

test("late persistence of the current user message does not duplicate the prompt", async () => {
  const f = fixture();
  f.start();
  f.tracer.handle(
    "before_message_write",
    { message: { role: "user", content: "question" } },
    { sessionKey: "run" },
  );
  f.model("m");
  f.completed("m");
  f.message(assistant([text("answer")]));
  f.emit("agent_end", { success: true });
  await f.tracer.drain();
  const model = [...f.spans.values()].find((s) => s.type === "model");
  assert.equal(io(model, "input").filter((m) => m.role === "user").length, 1);
});

// OpenClaw 2026.11.5 admission emits this error toolResult even when the
// requested name has no tool implementation and no tool hooks are invoked.
for (const name of ["read", "write", "apply_patch"]) {
  test(`unknown ${name} becomes an ERROR tool under its original ReAct round`, async () => {
    const f = fixture();
    f.start();
    f.model("request");
    f.completed("request");
    const args = { path: "example.txt" };
    f.message(
      assistant([{ type: "toolCall", id: "rejected", name, arguments: args }]),
    );
    const result = {
      role: "toolResult",
      toolCallId: "rejected",
      toolName: name,
      content: [text(`Tool ${name} not found`)],
      details: {},
      isError: true,
    };
    f.message(result);
    f.message(result); // Repeated terminal notification.
    f.model("recovery");
    f.completed("recovery");
    f.message(assistant([text("recovered")]));
    f.emit("llm_output", { assistantTexts: ["recovered"] });
    f.emit("agent_end", { success: true });
    await f.tracer.drain();
    const tools = [...f.spans.values()].filter((s) => s.type === "tool");
    assert.equal(tools.length, 1);
    const tool = tools[0];
    const model = [...f.spans.values()].find((s) => s.type === "model");
    assert.equal(tool.parentSpanId, model.parentSpanId);
    assert.deepEqual(io(tool, "input"), args);
    assert.deepEqual(io(tool, "output"), {
      content: result.content,
      details: {},
      isError: true,
    });
    assert.equal(tool.attributes["langfuse.observation.level"], "ERROR");
    assert.equal(
      tool.attributes["langfuse.observation.status_message"],
      `Tool ${name} not found`,
    );
    assert.equal(
      tool.attributes["langfuse.observation.metadata.toolCallId"],
      "rejected",
    );
    assert.equal(
      tool.attributes["langfuse.observation.metadata.captureSource"],
      "tool-result-fallback",
    );
    assert.equal(
      tool.attributes["langfuse.observation.metadata.executionTimingAvailable"],
      "false",
    );
    assert.equal(tool.startTime, tool.endTime);
    const root = [...f.spans.values()].find((s) => s.type === "agent");
    assert.equal(root.attributes["error.type"], undefined);
    assert.equal(io(root, "output"), "recovered");
  });
}

test("real tool hooks take precedence even when the error transcript arrives first", async () => {
  const f = fixture();
  f.start();
  f.model("m");
  f.completed("m");
  f.message(
    assistant([
      {
        type: "toolCall",
        id: "t",
        name: "read",
        arguments: { path: "original" },
      },
    ]),
  );
  f.message({
    role: "toolResult",
    toolCallId: "t",
    toolName: "read",
    isError: true,
    content: [text("transcript error")],
  });
  f.emit("before_tool_call", {
    toolCallId: "t",
    toolName: "read",
    params: { path: "effective" },
  });
  f.emit("after_tool_call", {
    toolCallId: "t",
    error: "actual error",
    result: { content: [text("actual error")] },
  });
  f.emit("agent_end", { success: false });
  await f.tracer.drain();
  const tools = [...f.spans.values()].filter((s) => s.type === "tool");
  assert.equal(tools.length, 1);
  assert.deepEqual(io(tools[0], "input"), { path: "effective" });
  assert.equal(
    tools[0].attributes["langfuse.observation.status_message"],
    "actual error",
  );
  assert.equal(
    tools[0].attributes["langfuse.observation.metadata.captureSource"],
    undefined,
  );
  assert.ok(tools[0].endTime > tools[0].startTime);
});

test("success text mentioning an unknown tool does not fabricate a failure", async () => {
  const f = fixture();
  f.start();
  f.model("m");
  f.completed("m");
  f.message(
    assistant([{ type: "toolCall", id: "t", name: "read", arguments: {} }]),
  );
  f.message({
    role: "toolResult",
    toolCallId: "t",
    toolName: "read",
    isError: false,
    content: [text("Tool read not found")],
  });
  f.emit("agent_end", { success: true });
  await f.tracer.drain();
  assert.equal(
    [...f.spans.values()].filter((s) => s.type === "tool").length,
    0,
  );
});

test("unmatched failed results are flagged rather than assigned guessed parameters", async () => {
  const f = fixture();
  f.start();
  f.model("m");
  f.completed("m");
  f.message(assistant([text("answer")]));
  f.message({
    role: "toolResult",
    toolCallId: "unknown",
    toolName: "read",
    isError: true,
    content: [text("Tool read not found")],
  });
  f.emit("agent_end", { success: true });
  await f.tracer.drain();
  assert.equal(
    [...f.spans.values()].filter((s) => s.type === "tool").length,
    0,
  );
  const root = [...f.spans.values()].find((s) => s.type === "agent");
  assert.equal(
    root.attributes["langfuse.observation.metadata.unattributedToolErrors"],
    "1",
  );
});

test("shutdown also flushes a rejected tool result", async () => {
  const f = fixture();
  f.start();
  f.model("m");
  f.completed("m");
  f.message(
    assistant([{ type: "toolCall", id: "t", name: "read", arguments: {} }]),
  );
  f.message({
    role: "toolResult",
    toolCallId: "t",
    toolName: "read",
    isError: true,
    content: [text("Tool read not found")],
  });
  await f.tracer.stop();
  const tool = [...f.spans.values()].find((s) => s.type === "tool");
  assert.equal(
    tool.attributes["langfuse.observation.status_message"],
    "Tool read not found",
  );
});

test("replays five sanitized production rejections without losing parameters or errors", async () => {
  const { readFileSync } = await import("node:fs");
  const pairs = JSON.parse(
    readFileSync(
      new URL("./fixtures/rejected-tools.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(pairs.length, 5);
  for (const { call, result } of pairs) {
    const f = fixture();
    f.start();
    f.model("m");
    f.completed("m");
    f.message(assistant([call]));
    f.message(result);
    f.emit("agent_end", { success: true });
    await f.tracer.drain();
    const tools = [...f.spans.values()].filter((s) => s.type === "tool");
    assert.equal(tools.length, 1);
    assert.deepEqual(io(tools[0], "input"), call.arguments);
    assert.equal(tools[0].attributes["error.type"], result.content[0].text);
  }
});

test("failed results with the same call ID stay isolated across concurrent runs", async () => {
  const f = fixture();
  for (const run of ["a", "b"]) {
    f.start(run);
    f.emit("model_call_started", { callId: "m", model: "fixture" }, run);
    f.emit(
      "model_call_ended",
      { callId: "m", outcome: "completed", durationMs: 5 },
      run,
    );
    f.emit(
      "before_message_write",
      {
        message: assistant([
          {
            type: "toolCall",
            id: "same",
            name: "read",
            arguments: { path: run },
          },
        ]),
      },
      run,
    );
    f.emit(
      "before_message_write",
      {
        message: {
          role: "toolResult",
          toolCallId: "same",
          toolName: "read",
          isError: true,
          content: [text(`Tool read not found: ${run}`)],
        },
      },
      run,
    );
  }
  for (const run of ["a", "b"]) f.emit("agent_end", { success: true }, run);
  await f.tracer.drain();
  const tools = [...f.spans.values()].filter((s) => s.type === "tool");
  assert.equal(tools.length, 2);
  assert.notEqual(tools[0].parentSpanId, tools[1].parentSpanId);
  for (const tool of tools)
    assert.equal(
      tool.attributes["error.type"],
      `Tool read not found: ${io(tool, "input").path}`,
    );
});

test("duplicate tool call IDs across models and mismatched tool names are not guessed", async () => {
  for (const ambiguous of [false, true]) {
    const f = fixture();
    f.start();
    for (const name of ambiguous ? ["m1", "m2"] : ["m1"]) {
      f.model(name);
      f.completed(name);
      f.message(
        assistant([
          { type: "toolCall", id: "same", name: "read", arguments: {} },
        ]),
      );
    }
    f.message({
      role: "toolResult",
      toolCallId: "same",
      toolName: ambiguous ? "read" : "write",
      isError: true,
      content: [text("not found")],
    });
    f.emit("agent_end", { success: true });
    await f.tracer.drain();
    assert.equal(
      [...f.spans.values()].filter((s) => s.type === "tool").length,
      0,
    );
    assert.equal(
      [...f.spans.values()].find((s) => s.type === "agent").attributes[
        "langfuse.observation.metadata.unattributedToolErrors"
      ],
      "1",
    );
  }
});
