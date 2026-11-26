#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
command -v python3 >/dev/null || { echo 'Требуется Python 3.10+.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'Требуется Node.js 20+ и npm.' >&2; exit 1; }
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-dev.txt
if [[ -f frontend/package-lock.json ]]; then
    npm --prefix frontend ci
else
    npm --prefix frontend install
fi
bash scripts/format.sh
npm --prefix frontend run build
.venv/bin/python manage.py migrate
.venv/bin/python manage.py check
echo 'Установка завершена. Создайте пользователя: .venv/bin/python manage.py createsuperuser'
