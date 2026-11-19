# Installing this fork

This guide applies to `liuchuan01/openclaw-exporter-to-langfuse`, targeting **OpenClaw 2026.11.5 only**. Upstream npm packages and Alibaba Cloud OSS installers are different artifacts. Do not use them to install or update this fork.

## Build a reviewable package

Check out the commit you intend to deploy, then run:

```bash
openclaw --version
npm ci --ignore-scripts
bash scripts/pack.sh
```

The packaging script synchronizes VERSION, runs the tests, replaces the generated release directory and builds the npm package. Outputs are under `release/v<version>/`:

- `openclaw-exporter-to-langfuse-<version>.tgz`: the plugin package.
- `INSTALLATION.md`, `README.md` and `VALIDATION.md`: installation, configuration and validation notes.
- `build-info.json`: source commit, working-tree status, Node version, plugin version and target OpenClaw version.
- `install.sh` and `check-runtime.mjs`: operator-run authorization, reload and runtime verification helpers.
- `SHA256SUMS`: checksums for the package, documentation, helpers and build information.

For reproducible deployments, use a clean checkout of a recorded commit. A checksum detects changed bytes only when compared with a trusted copy; it is not a publisher signature or a ClawHub review. No artifacts are published or uploaded by this script.

## Install and configure

Inspect the package and compare its checksum with your approved artifact. For version 0.2.0:

```bash
tar -tzf release/v0.2.0/openclaw-exporter-to-langfuse-0.2.0.tgz
openclaw plugins install ./release/v0.2.0/openclaw-exporter-to-langfuse-0.2.0.tgz
```

The package includes the compiled plugin, manifest and VERSION; it excludes the standalone upstream onboard CLI. It sends traces directly to the configured Langfuse OTLP endpoint. No collector service or Python OTLP receiver is installed.

### Configure the endpoint, then grant host authorization

Use the [README JSON example](./README.md#installation), or configure the fields individually (replace the placeholders):

```bash
openclaw config set plugins.entries.openclaw-exporter-to-langfuse.config.endpoint 'https://cloud.langfuse.com/api/public/otel'
openclaw config set plugins.entries.openclaw-exporter-to-langfuse.config.headers '{"Authorization":"Basic <base64-public-key-colon-secret-key>"}'
bash scripts/install.sh
```

Run these commands as the same user, with the same OpenClaw profile/state directory as the running gateway. The helper runs these steps in order and exits nonzero on any failure:

```bash
openclaw config set plugins.entries.openclaw-exporter-to-langfuse.hooks.allowConversationAccess true
openclaw plugins reload openclaw-exporter-to-langfuse --wait
node scripts/check-runtime.mjs
```

**The authorization belongs in `plugins.entries.<id>.hooks`, alongside `config`, not inside `config`.** It is a host-side grant made by the operator. The plugin cannot authorize itself; a manifest declaration is not a grant. This fork removes that misleading manifest field.

The helper does not download upstream packages or configure your credentials. With no argument it authorizes and checks an already-installed plugin. For a preconfigured deployment it can first install a reviewed local package: `bash scripts/install.sh /path/to/plugin.tgz`. It never adds `--force`. If the package requires a policy override, install it explicitly after review, then rerun the helper without an argument.

Release directories include `install.sh` and `check-runtime.mjs` side by side: run `bash ./install.sh` from that directory. These operator tools are not part of the runtime npm plugin and do not execute automatically when the plugin loads.

Authorization changes take effect through plugin hot reload; a whole-gateway restart is not normally necessary on the pinned host. Reload requires a running gateway. If it fails, the helper reports failure rather than claiming success or restarting the gateway. Preserve other plugins and their settings.

### Local-package trust prompts

A local tarball does not acquire ClawHub provenance by being built here. If installation reports `provenance-invalid`, read the exact reason and inspect the exact artifact; that label alone does not establish whether code is safe. This fork does not forge provenance or disable the host's checks.

If the host requires `--force` for the reviewed local artifact, treat that as an explicit installation-policy override. Check `openclaw plugins install --help` for your pinned host's behavior. Packaging and helper scripts never append `--force` automatically.

## Verify the installation

The setup helper always runs:

```bash
openclaw plugins inspect openclaw-exporter-to-langfuse --runtime --json
```

It asserts the plugin is loaded, enabled and activated; `plugin.hookCount === 8`; all eight required names appear in `typedHooks`; and `diagnostics` contains no `blocked` message or error. Invalid JSON, missing fields and CLI failures also fail the check. To rerun it independently: `node scripts/check-runtime.mjs`.

Required hooks: `llm_input`, `llm_output`, `agent_end`, `model_call_started`, `model_call_ended`, `before_tool_call`, `after_tool_call`, `before_message_write`.

**Silent failure symptom:** the plugin can be loaded/activated, its service running and its OTLP endpoint healthy while only five hooks register. Missing host authorization blocks `llm_input`, `llm_output` and `agent_end`. There may be no error log. In this fork `llm_input` starts the root span and `agent_end` finishes it; without these hooks the normal trace cannot be produced. Check the runtime hook inventory before debugging Langfuse credentials.

The runtime check establishes hook registration, not network delivery or artifact trust.

Send a request that calls a tool. In Langfuse, check that one `invoke_agent` trace contains `react_step`, `model_call` and tool observations, with the expected input/output. Confirm the installed plugin version and remove any duplicate tracing plugin from this request's path. See [VALIDATION.md](./VALIDATION.md) for the tested behavior and limits.

For upgrades, retain the current configuration and previous reviewed package, then follow your pinned host's plugin update procedure. For removal, consult `openclaw plugins uninstall --help` and remove only this plugin. The upstream OSS installation workflow remains removed. The local setup helper touches only this plugin's conversation-access grant; the legacy uninstall script stays disabled and does not modify collector services.

Host CLI reference: [OpenClaw plugins](https://docs.openclaw.ai/cli/plugins).
