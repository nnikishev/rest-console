#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -x .venv/bin/python ]] || { echo 'Сначала выполните: bash scripts/install.sh' >&2; exit 1; }
[[ -d frontend/node_modules ]] || { echo 'Не установлены frontend-зависимости. Выполните: bash scripts/install.sh' >&2; exit 1; }
bash scripts/format.sh
npm --prefix frontend run build
.venv/bin/python manage.py migrate
.venv/bin/python manage.py check
exec .venv/bin/python manage.py runserver "${1:-127.0.0.1:8000}"
