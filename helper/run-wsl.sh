#!/usr/bin/env bash
# Runs the Songbook helper in WSL2 Ubuntu with GPU analysis (helper/README.md).
#   bash helper/run-wsl.sh [--port 8765] [other songbook_helper.py options]
# From Windows:  wsl -d Ubuntu-24.04 -- bash helper/run-wsl.sh   (in the repo folder)
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1090
source ~/.venvs/songbook/bin/activate
exec python helper/songbook_helper.py "$@"
