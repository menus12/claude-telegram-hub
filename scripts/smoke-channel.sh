#!/usr/bin/env bash
# Prove the packed channel is a self-contained plugin: it must boot with NO
# node_modules on disk (the exact scenario a real install faces). Run from the
# repo root after the channel is built (npm run build).
set -euo pipefail

npm pack -w @claude-telegram-hub/channel >/dev/null
tgz=$(ls claude-telegram-hub-channel-*.tgz | head -1)
echo "packed $tgz"

work=$(mktemp -d)
tar -xzf "$tgz" -C "$work"
rm -f "$tgz"
pkg="$work/package"

# Shape checks — the standalone artifact, no workspace/node_modules.
test -f "$pkg/dist/main.cjs"
test -f "$pkg/.mcp.json"
test -f "$pkg/.claude-plugin/plugin.json"
test ! -d "$pkg/node_modules"

# Boot it against a dead hub; it must start (not ERR_MODULE_NOT_FOUND).
cd "$pkg"
set +e
TELEGRAM_HUB_URL=ws://127.0.0.1:59999 TELEGRAM_HUB_SECRET=x TELEGRAM_HUB_AGENT=ci \
  timeout 4 node dist/main.cjs >out.log 2>err.log
set -e

echo "--- channel stderr ---"
cat err.log
if grep -qiE "ERR_MODULE_NOT_FOUND|Dynamic require|SyntaxError" err.log; then
  echo "FAIL: channel bundle is not self-contained"
  exit 1
fi
grep -q '"msg":"channel started"' err.log || {
  echo "FAIL: channel did not boot"
  exit 1
}
echo "PASS: channel boots standalone with no node_modules"
