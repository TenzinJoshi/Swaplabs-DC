#!/bin/zsh
set -eu
cd "$(dirname "$0")"
task_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
if [[ ! -x "$task_node" ]]; then
  task_node="$(command -v node || true)"
fi
if [[ -z "$task_node" || ! -x "$task_node" ]]; then
  print "Node.js could not be found. Install Node.js 22 or newer, then open this launcher again."
  read -k 1
  exit 1
fi
export PATH="$(dirname "$task_node"):$PATH"
exec "$task_node" scripts/local-start.mjs --open
