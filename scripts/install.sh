#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ID="openclaw-exporter-to-langfuse"
if [[ $# -gt 1 || "${1:-}" == --* ]]; then
  echo "Usage: bash install.sh [reviewed-local-package.tgz]" >&2
  echo "Configure endpoint and Authorization before running this setup helper." >&2
  exit 1
fi
if [[ $# -eq 1 ]]; then
  if [[ ! -f "$1" || "$1" != *.tgz ]]; then
    echo "Expected a reviewed local .tgz file; remote specs are not accepted." >&2
    exit 1
  fi
  openclaw plugins install "$1"
fi

# This is an operator-run host configuration change, not plugin self-authorization.
# Use the same OpenClaw user/profile/state directory as the target gateway.
openclaw config set "plugins.entries.${PLUGIN_ID}.hooks.allowConversationAccess" true
openclaw plugins reload "$PLUGIN_ID" --wait
node "$SCRIPT_DIR/check-runtime.mjs"
