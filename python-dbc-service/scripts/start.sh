# scripts/start.sh
#!/bin/bash
set -e

echo "🚀 Starting DBC Service..."

if [[ "$VIRTUAL_ENV" == "" ]]; then
    echo "⚠️  Virtual environment not activated"
fi

if [ ! -f "pyproject.toml" ]; then
    echo "❌ Run from project root"
    exit 1
fi

mkdir -p logs

poetry install --no-dev
poetry run dbc-service