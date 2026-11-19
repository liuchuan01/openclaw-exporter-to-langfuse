import assert from "node:assert/strict";
import test from "node:test";
import {
  chatMessage,
  jsonAttribute,
  usageAttributes,
} from "../dist/messages.js";

test("assistant tool calls and results use matching OpenAI chat IDs", () => {
  const assistant = chatMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Read the next file" },
      {
        type: "toolCall",
        id: "call-1",
        name: "read",
        arguments: { path: "next.txt" },
      },
    ],
  });
  assert.equal(assistant.reasoning_content, "Read the next file");
  assert.equal(
    assistant.tool_calls[0].function.arguments,
    '{"path":"next.txt"}',
  );
  assert.deepEqual(
    chatMessage({
      role: "toolResult",
      toolCallId: "call-1",
      content: [{ type: "text", text: "17" }],
    }),
    { role: "tool", tool_call_id: "call-1", content: "17" },
  );
});

test("cache reads do not erase uncached input tokens", () => {
  const attrs = usageAttributes({
    input: 177,
    output: 337,
    cacheRead: 16256,
    cacheWrite: 0,
    total: 16770,
  });
  assert.deepEqual(JSON.parse(attrs["langfuse.observation.usage_details"]), {
    input: 177,
    output: 337,
    cache_read: 16256,
    cache_write: 0,
    total: 16770,
  });
});

test("oversized IO is explicitly marked and still valid JSON", () => {
  assert.equal(
    JSON.parse(jsonAttribute({ text: '"'.repeat(2000) }, 500)).truncated,
    true,
  );
  assert.deepEqual(
    JSON.parse(jsonAttribute([{ role: "user", content: "hello" }])),
    [{ role: "user", content: "hello" }],
  );
});
