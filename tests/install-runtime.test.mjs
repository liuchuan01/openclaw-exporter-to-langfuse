import test from "node:test";
import assert from "node:assert/strict";
import {
  assertRuntime,
  PLUGIN_ID,
  REQUIRED_HOOKS,
} from "../scripts/check-runtime.mjs";

function report() {
  return {
    plugin: {
      id: PLUGIN_ID,
      enabled: true,
      activated: true,
      status: "loaded",
      hookCount: 8,
    },
    typedHooks: REQUIRED_HOOKS.map((name) => ({ name })),
    diagnostics: [],
  };
}
test("runtime check accepts all eight active hooks", () =>
  assert.doesNotThrow(() => assertRuntime(report())));
test("loaded plugin with five hooks fails explicitly", () => {
  const value = report();
  value.plugin.hookCount = 5;
  value.typedHooks = value.typedHooks.filter(
    ({ name }) => !["llm_input", "llm_output", "agent_end"].includes(name),
  );
  assert.throws(() => assertRuntime(value), /allowConversationAccess/);
});
test("eight hooks cannot hide a missing required hook or blocked diagnostics", () => {
  const value = report();
  value.typedHooks[0] = { name: "unrelated" };
  assert.throws(() => assertRuntime(value), /missing: llm_input/);
  const blocked = report();
  blocked.diagnostics = [{ level: "warn", message: "hook blocked by host" }];
  assert.throws(() => assertRuntime(blocked), /blocked hook/);
});
test("inactive, malformed and error responses fail closed", () => {
  const inactive = report();
  inactive.plugin.activated = false;
  const missing = report();
  delete missing.diagnostics;
  const error = report();
  error.diagnostics = [{ level: "error", message: "registration failed" }];
  for (const value of [null, {}, inactive, missing, error])
    assert.throws(() => assertRuntime(value));
});

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

for (const mode of ["ok", "grant-fails", "reload-fails", "blocked"]) {
  test(`setup helper checks host authorization and stops on failure: ${mode}`, () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-setup-test-"));
    try {
      const response = report();
      if (mode === "blocked") response.plugin.hookCount = 5;
      const log = join(directory, "commands.jsonl");
      writeFileSync(
        join(directory, "openclaw"),
        `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (${JSON.stringify(mode)} === 'grant-fails' && args[0] === 'config') process.exit(1);
if (${JSON.stringify(mode)} === 'reload-fails' && args[1] === 'reload') process.exit(1);
if (args[1] === 'inspect') console.log(${JSON.stringify(JSON.stringify(response))});
`,
        { mode: 0o755 },
      );
      const result = spawnSync("bash", ["scripts/install.sh"], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      });
      assert.equal(result.status, mode === "ok" ? 0 : 1, result.stderr);
      const calls = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.deepEqual(calls[0], [
        "config",
        "set",
        `plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess`,
        "true",
      ]);
      assert.equal(
        calls.length,
        mode === "grant-fails" ? 1 : mode === "reload-fails" ? 2 : 3,
      );
      if (calls.length > 1)
        assert.deepEqual(calls[1], ["plugins", "reload", PLUGIN_ID, "--wait"]);
      if (calls.length > 2)
        assert.deepEqual(calls[2], [
          "plugins",
          "inspect",
          PLUGIN_ID,
          "--runtime",
          "--json",
        ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
