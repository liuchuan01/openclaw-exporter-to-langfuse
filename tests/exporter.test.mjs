import test from "node:test";
import assert from "node:assert/strict";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";
import { LangfuseExporter } from "../dist/langfuse-exporter.js";

test("OTel exporter preserves parent IDs, observation types and error status", async () => {
  const sink = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(sink)],
  });
  const exporter = new LangfuseExporter(
    {
      logger: {
        info() {},
        error(m) {
          assert.fail(m);
        },
      },
    },
    {},
  );
  // Keep the real OTel span implementation, replace only network transport.
  exporter.provider = provider;
  exporter.tracer = provider.getTracer("test");
  exporter.initialized = true;
  await exporter.startSpan(
    { name: "root", type: "agent", startTime: 1000, attributes: {} },
    "root",
  );
  await exporter.startSpan(
    {
      name: "read",
      type: "tool",
      startTime: 1010,
      parentSpanId: "root",
      attributes: {},
    },
    "tool",
  );
  exporter.endSpanById("tool", 1020, {
    "error.type": "ENOENT",
    "langfuse.observation.status_message": "ENOENT",
  });
  exporter.endSpanById("root", 1030);
  await exporter.flush();
  const [tool, root] = sink.getFinishedSpans();
  assert.equal(tool.parentSpanContext.spanId, root.spanContext().spanId);
  assert.equal(tool.spanContext().traceId, root.spanContext().traceId);
  assert.equal(tool.status.code, SpanStatusCode.ERROR);
  assert.equal(root.status.code, SpanStatusCode.OK);
  assert.equal(tool.attributes["langfuse.observation.type"], "tool");
  assert.equal(root.attributes["langfuse.observation.type"], "agent");
  await exporter.dispose();
});
