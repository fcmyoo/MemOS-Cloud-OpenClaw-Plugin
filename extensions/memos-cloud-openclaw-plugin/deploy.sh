#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/root/workspace/MemOS-Cloud-OpenClaw-Plugin"
PLUGIN_ID="memos-cloud-openclaw-plugin"
TEST_HOME="/tmp/memos-plugin-test-home"

cd "$APP_DIR"

echo "[deploy] branch=$(git rev-parse --abbrev-ref HEAD) commit=$(git rev-parse --short HEAD)"

echo "[deploy] install dependencies"
npm install --no-audit --no-fund

echo "[deploy] run tests (isolated HOME to avoid runtime .env pollution)"
mkdir -p "$TEST_HOME"
HOME="$TEST_HOME" npm test

echo "[deploy] pack plugin"
TARBALL=$(npm pack | awk 'NF{last=$0} END{print last}')

echo "[deploy] install plugin: $TARBALL"
openclaw plugins install "$APP_DIR/$TARBALL"
openclaw plugins enable "$PLUGIN_ID" || true

echo "[deploy] restart gateway"
openclaw gateway restart

echo "[deploy] verify plugin"
openclaw plugins info "$PLUGIN_ID" | sed -n '1,80p'

echo "[deploy] done"
