#!/usr/bin/env bash
set -euo pipefail

cat >&2 <<'MESSAGE'
The upstream uninstall script is disabled in this fork.
Follow INSTALLATION.md and consult openclaw plugins uninstall --help
for your pinned host. No plugins, configuration or services were changed.
MESSAGE
exit 1
