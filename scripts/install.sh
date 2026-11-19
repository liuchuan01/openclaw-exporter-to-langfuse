#!/usr/bin/env bash
set -euo pipefail

# Keep the old entry point from silently installing an upstream artifact.
cat >&2 <<'MESSAGE'
The upstream download installer is disabled in this fork.
Follow INSTALLATION.md in the repository: build with bash scripts/pack.sh,
then install the reviewed local .tgz with openclaw plugins install.
No installation or configuration changes were made.
MESSAGE
exit 1
