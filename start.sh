#!/usr/bin/env bash
# MC-MultiLogin 一键启动脚本（Linux / macOS）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js not found. Please install Node.js v21+ from https://nodejs.org"
    exit 1
fi

if [ ! -d node_modules ]; then
    echo "[INFO] First run: installing dependencies (npm install)..."
    npm install
fi

echo "[INFO] Starting MC-MultiLogin service..."
echo "[INFO] Ports and methods are configured in config/config.json (management panel: manage_port + manage_url)"
exec node src/index.js
