#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

npm run version-sync
npm test

VERSION=$(tr -d '[:space:]' < VERSION)
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][a-zA-Z0-9.-]+)?$ ]]; then
  echo "Invalid plugin VERSION" >&2
  exit 1
fi
OUTPUT_DIR="${PROJECT_DIR}/release/v${VERSION}"
rm -rf "${PROJECT_DIR}/release"
mkdir -p "$OUTPUT_DIR"
npm pack --ignore-scripts --pack-destination "$OUTPUT_DIR"
cp INSTALLATION.md README.md VALIDATION.md "$OUTPUT_DIR/"

node --input-type=module - "$OUTPUT_DIR" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const directory = process.argv[2];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = !!execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim();
writeFileSync(join(directory, "build-info.json"), JSON.stringify({
  sourceRepository: "https://github.com/liuchuan01/openclaw-exporter-to-langfuse",
  sourceCommit: commit,
  workingTreeDirty: dirty,
  pluginVersion: pkg.version,
  openclawVersion: pkg.openclaw.build.openclawVersion,
  nodeVersion: process.version,
}, null, 2) + "\n");
const files = [`${pkg.name}-${pkg.version}.tgz`, "INSTALLATION.md", "README.md", "VALIDATION.md", "build-info.json"];
writeFileSync(join(directory, "SHA256SUMS"), files.map((file) =>
  `${createHash("sha256").update(readFileSync(join(directory, file))).digest("hex")}  ${file}\n`
).join(""));
console.log(`Local release artifacts: ${directory}`);
NODE
