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
- `SHA256SUMS`: checksums for the package, documentation and build information.

For reproducible deployments, use a clean checkout of a recorded commit. A checksum detects changed bytes only when compared with a trusted copy; it is not a publisher signature or a ClawHub review. No artifacts are published or uploaded by this script.

## Install and configure

Inspect the package and compare its checksum with your approved artifact. For version 0.2.0:

```bash
tar -tzf release/v0.2.0/openclaw-exporter-to-langfuse-0.2.0.tgz
openclaw plugins install ./release/v0.2.0/openclaw-exporter-to-langfuse-0.2.0.tgz
```

The package includes the compiled plugin, manifest and VERSION; it excludes the standalone upstream onboard CLI. It sends traces directly to the configured Langfuse OTLP endpoint. No collector service or Python OTLP receiver is installed.

Use the configuration example in the [README](./README.md#installation): set your endpoint and Authorization header, enable conversation-access hooks, and merge the entry into your existing plugin configuration. Preserve other plugins and their settings. Restart the gateway using your deployment's service manager.

### Local-package trust prompts

A local tarball does not acquire ClawHub provenance by being built here. If installation reports `provenance-invalid`, read the exact reason and inspect the exact artifact; that label alone does not establish whether code is safe. This fork does not forge provenance or disable the host's checks.

If the host requires `--force` for the reviewed local artifact, treat that as an explicit installation-policy override. Check `openclaw plugins install --help` for your pinned host's behavior. Packaging and helper scripts never append `--force` automatically.

## Verify the installation

Send a request that calls a tool. In Langfuse, check that one `invoke_agent` trace contains `react_step`, `model_call` and tool observations, with the expected input/output. Confirm the installed plugin version and remove any duplicate tracing plugin from this request's path. See [VALIDATION.md](./VALIDATION.md) for the tested behavior and limits.

For upgrades, retain the current configuration and previous reviewed package, then follow your pinned host's plugin update procedure. For removal, consult `openclaw plugins uninstall --help` and remove only this plugin. The old OSS install/uninstall scripts are disabled in this fork; they must not modify unrelated collector services.
