/** Render OpenClaw messages as role-labelled Langfuse chat messages. */
export type Message = Record<string, any>;

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content))
    return content == null ? "" : JSON.stringify(content);
  return content
    .map((part) =>
      typeof part === "string" ? part : (part?.text ?? part?.content ?? ""),
    )
    .filter((part) => typeof part === "string")
    .join("\n");
}

export function chatMessage(message: Message): Message {
  const role =
    message.role === "toolResult"
      ? "tool"
      : message.role === "custom"
        ? "system"
        : message.role;
  if (role === "tool") {
    return {
      role,
      tool_call_id: message.toolCallId,
      content: contentText(message.content),
    };
  }
  if (role !== "assistant" || !Array.isArray(message.content)) {
    return { role, content: message.content ?? "" };
  }
  const text = message.content
    .filter((part: Message) => part.type === "text")
    .map((part: Message) => part.text ?? "")
    .join("\n");
  const reasoning = message.content
    .filter(
      (part: Message) => part.type === "thinking" || part.type === "reasoning",
    )
    .map((part: Message) => part.thinking ?? part.text ?? part.content ?? "")
    .join("\n");
  const calls = message.content
    .filter((part: Message) => part.type === "toolCall")
    .map((part: Message) => ({
      id: part.id,
      type: "function",
      function: {
        name: part.name,
        arguments:
          typeof part.arguments === "string"
            ? part.arguments
            : JSON.stringify(part.arguments ?? {}),
      },
    }));
  return {
    role,
    content: text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
  };
}

/** A bounded attribute remains valid JSON, even when its content is too large. */
export function jsonAttribute(value: unknown, limit = 3_200_000): string {
  const encoded = JSON.stringify(value) ?? "null";
  return encoded.length <= limit
    ? encoded
    : JSON.stringify({
        truncated: true,
        originalChars: encoded.length,
        preview: encoded.slice(0, Math.max(0, (limit - 100) / 6)),
      });
}

/** OpenClaw input excludes cache reads/writes. Keep disjoint usage categories. */
export function usageAttributes(
  usage: Message | undefined,
): Record<string, string> {
  if (!usage) return {};
  const details: Record<string, number> = {};
  for (const [source, target] of [
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cache_read"],
    ["cacheWrite", "cache_write"],
  ]) {
    const value = usage[source];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      details[target] = value;
  }
  const total = usage.total ?? usage.totalTokens;
  if (typeof total === "number" && Number.isFinite(total) && total >= 0)
    details.total = total;
  return { "langfuse.observation.usage_details": JSON.stringify(details) };
}
