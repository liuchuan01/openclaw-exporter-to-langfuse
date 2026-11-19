import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const PLUGIN_ID = "openclaw-exporter-to-langfuse";
export const REQUIRED_HOOKS = [
  "llm_input",
  "llm_output",
  "agent_end",
  "model_call_started",
  "model_call_ended",
  "before_tool_call",
  "after_tool_call",
  "before_message_write",
];

/** Validate the pinned OpenClaw 2026.11.5 runtime inspect response. */
export function assertRuntime(report) {
  const plugin = report?.plugin;
  if (
    plugin?.id !== PLUGIN_ID ||
    plugin.status !== "loaded" ||
    plugin.enabled !== true ||
    plugin.activated !== true
  ) {
    throw new Error(
      "Plugin is not loaded, enabled and activated in the running gateway.",
    );
  }
  const names = new Set((report.typedHooks ?? []).map((hook) => hook.name));
  const missing = REQUIRED_HOOKS.filter((name) => !names.has(name));
  if (plugin.hookCount !== REQUIRED_HOOKS.length || missing.length) {
    throw new Error(
      `Expected 8 runtime hooks, found ${plugin.hookCount ?? "unknown"}; missing: ${missing.join(", ") || "none"}. Check plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess=true, then reload the plugin.`,
    );
  }
  if (!Array.isArray(report.diagnostics)) {
    throw new Error("Runtime inspect response is missing diagnostics.");
  }
  if (
    report.diagnostics.some(
      (item) =>
        /\bblocked\b/i.test(JSON.stringify(item)) || item.level === "error",
    )
  ) {
    throw new Error(
      "Runtime diagnostics contain a blocked hook or error. Inspect the plugin diagnostics before proceeding.",
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const output = execFileSync(
      "openclaw",
      ["plugins", "inspect", PLUGIN_ID, "--runtime", "--json"],
      {
        encoding: "utf8",
        stdio: ["inherit", "pipe", "inherit"],
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assertRuntime(JSON.parse(output));
    console.log(
      "Runtime check passed: plugin active, all 8 hooks registered, no blocked/error diagnostics. Send a tool request to verify Langfuse delivery.",
    );
  } catch (error) {
    console.error(`Runtime check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
