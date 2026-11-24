# openclaw-exporter-to-langfuse

**English** | [中文](./README.zh.md)

This fork adapts the Alibaba Cloud exporter to **OpenClaw 2026.11.1 and 2026.11.5**. OpenClaw hooks send agent, model and tool observations directly to Langfuse over OTLP. No Python receiver, trajectory sidecars or session database reader is required.

## Installation

Follow [INSTALLATION.md](./INSTALLATION.md) to build, inspect and install this fork. It is the single installation guide, including local-package trust prompts and upgrade/removal guidance. Upstream npm packages and OSS installers do not contain this fork.

Configure the entry in `openclaw.json`, then run the authorization/reload helper in [INSTALLATION.md](./INSTALLATION.md#configure-the-endpoint-then-grant-host-authorization). Replace the authorization placeholder with base64 of `public-key:secret-key`.

```json
{
  "plugins": {
    "allow": ["openclaw-exporter-to-langfuse"],
    "entries": {
      "openclaw-exporter-to-langfuse": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "endpoint": "https://cloud.langfuse.com/api/public/otel",
          "headers": { "Authorization": "Basic <base64-public-key-colon-secret-key>" },
          "serviceName": "openclaw-agent",
          "tags": ["openclaw"]
        }
      }
    }
  }
}
```

**`hooks.allowConversationAccess` is a host grant alongside `config`, not a plugin config field. The manifest cannot grant it. When using individual `openclaw config set` commands, do not omit this authorization.** Setup hot-reloads this plugin and requires all eight runtime hooks with no blocked/error diagnostics; loaded/activated status alone is insufficient.

Merge this entry into your existing configuration, preserving other installed plugins. Enable only one Langfuse tracing plugin for these runs to avoid duplicate exports. This plugin captures conversation content, reasoning when supplied by the model, and tool arguments/results.

## Reported observations

```text
invoke_agent (AGENT; one trace per runId)
├─ react_step (SPAN; provider call / ReAct round)
│  ├─ model_call (GENERATION)
│  └─ exec (TOOL)
│     └─ read (TOOL; Code Mode nested call)
└─ react_step
   └─ model_call (GENERATION; final answer)
```

| Observation | Input / output |
|-------------|----------------|
| Agent | Question / final answer |
| Generation | Accumulated role-labelled context / assistant text, reasoning and tool calls |
| Tool | Arguments / result, including error payloads |
| ReAct step | Structural grouping; no duplicated input/output |

Generations use `model_call_started` / `model_call_ended` for provider timing. `before_message_write` supplies assistant output and usage. Input is reconstructed from `llm_input` plus subsequent conversation messages; metadata records `inputSource=openclaw-hooks-reconstructed`. This is not a byte-for-byte provider request: provider transforms or silent compaction can differ. Prepared tool definitions are metadata, not extra chat messages.

Nested Code Mode artifacts marked `excludeFromContext` are not inserted into the next generation's context. Nested tools still have their own observations. Failed tools retain their results and ERROR status; recovery does not turn the whole successful agent into an error. Failed provider calls without assistant messages are explicitly marked `outputUnavailable`.

Failed `toolResult` messages without tool hooks (including unknown tool names) also produce ERROR Tool observations when their call ID and name uniquely match an assistant call in the same run. Hook-created observations take precedence, so delayed hooks do not duplicate the tool. Fallback observations carry `captureSource=tool-result-fallback` and `executionTimingAvailable=false`: their timestamp marks when the result was observed, and their zero-length interval is not measured execution time. Unmatched failures are counted as `unattributedToolErrors` on the agent instead of guessing parameters or parents. This applies to newly observed runs; it does not backfill historical traces.

Run ID controls trace ownership; session ID groups conversation runs. Because message-write hooks supply only a session key, overlapping runs in the same session cannot always be attributed. In that case the plugin drops ambiguous messages and marks context incomplete instead of mixing their data. Missing terminal events are closed as incomplete on shutdown or after 20 minutes of inactivity.

## Configuration

`endpoint` and `headers.Authorization` are required. Existing `serviceName`, `tags`, `userId`, `debug`, `batchSize`, `flushIntervalMs`, `skillsRoots` and `skillTaggingEnabled` settings remain supported. Omit `enabledHooks`: the lifecycle hooks must be enabled together.

Static `tags` can filter these traces. **Optional experiment association and per-request metadata propagation are available with `evaluationEnabled: true`.** See [EVALUATION.md](./EVALUATION.md) and the [JS SDK example](https://github.com/liuchuan01/openclaw-exporter-to-langfuse/blob/feat/openclaw-2026-11-5/examples/vse-experiment/README.md). Langfuse scores can reference the exported trace and observation IDs.

## Development

```bash
npm test
npm run build
```

Tests use Node's built-in test runner, including an in-memory OpenTelemetry exporter. The exporter retains a private tracer provider and does not replace the gateway's global provider. See [validation notes](./VALIDATION.md) for live checks. Older architecture tutorials remain historical references; installation is maintained only in INSTALLATION.md.
