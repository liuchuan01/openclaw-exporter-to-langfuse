# Validation — OpenClaw 2026.11.5

## Environment

- OpenClaw image: `ghcr.io/openclaw/openclaw@sha256:9c74476e3e79b5a1595fd5cf904286eaba3471c10c640aaa9a361a89b41d0882` (2026.11.5).
- Model: DeepSeek official endpoint, `deepseek-flash`.
- Langfuse test server reports **4.80.0**, not the initially requested 4.88.0. Version 4.88.0 still needs a customer-environment acceptance test.
- Plugin directly exports OTLP. The test client only invokes the gateway and reads results; no local OTLP receiver participates.
- Separate lab-only hook logging supplies comparison evidence; it is not included in the plugin package.

## Automated checks

`npm test`: 21 passing Node tests, including upstream skill-tagging tests. New tests cover full ReAct context, tool-call/result rendering, real provider timing, cache accounting, nested tool parents and errors, retries, concurrent run isolation, ambiguous session ownership, duplicate hooks, service shutdown, non-serializable prepared tool callbacks, and late user-message persistence. The exporter test uses real OpenTelemetry spans with an in-memory transport.

`npm pack`: verified VERSION and compiled register entry are included; the upstream standalone installer CLI is excluded. Imported the extracted package successfully with dependencies supplied by the checkout.

## Live acceptance

Synthetic file-chain requests and error-recovery requests are sent through the ordinary Gateway WebSocket API. Acceptance reads the actual Langfuse observations back and checks:

- Exactly one agent root and trace per run, with every parent observation present.
- Every successful generation and tool has input/output; structural ReAct groups intentionally do not duplicate content.
- Each model input retains the original question exactly once and accumulates prior tool results.
- The final file-chain generation contains values 17 and 25 and project code ORCHID-27.
- Every observed model/tool call has a corresponding generation/tool observation.
- Model durations match `model_call_ended.durationMs`; input, output and cache usage match assistant-message usage.
- Nested Code Mode tools retain their parent; excluded internal artifacts do not become additional model messages.
- A failed mandatory file read has ERROR status, visible error output and status message; its recovered agent succeeds.

The browser session has no Langfuse UI login, so verification uses the authenticated API readback, not a claim of visual UI acceptance.

### Readback results (2026-11-19)

| Case | Generations | Tools | ReAct groups | Agent roots |
|------|-------------|-------|--------------|-------------|
| Three-file chain | 4 | 6 (3 exec + 3 read) | 4 | 1 |
| Missing file, then recovery | 3 | 4 (2 exec + 2 read) | 3 | 1 |

- File-chain trace: `3c81d7417b0b2391637a0449b8f4ab41`; model durations 1588 / 1228 / 907 / 967 ms.
- Recovery trace: `f75ee92e72fad0dd596aa3b91ca5226e`; model durations 931 / 1007 / 1157 ms. The failed nested read and its outer exec both report errors; the agent completes successfully.
- Two additional requests overlapped in time in separate sessions. Each produced its own 3-observation trace (agent + group + generation), with no cross-session question or answer leakage.
- The official Python Langfuse SDK 5.2.0 submitted 7 `integration_native_turn_io_complete` scores against the 7 native generation IDs. API readback verifies their observation associations. These are integration checks, not answer-quality evaluations.

## Limits

Model input is reconstructed from hooks, not intercepted provider HTTP payloads. Silent provider transformations/compaction are outside this contract. Overlapping runs within one session can produce unassignable session-only message hooks; these are flagged, not guessed. Other OpenClaw versions, multimodal rendering and long-running compaction need separate acceptance tests.

Python SDK experiment linkage and per-request metadata propagation remain a subsequent change. Scores in this validation measure trace data completeness only, not model answer quality.
