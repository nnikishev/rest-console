#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -x .venv/bin/ruff ]] || { echo 'Сначала выполните: bash scripts/install.sh' >&2; exit 1; }
.venv/bin/ruff check --fix .
.venv/bin/ruff format .
