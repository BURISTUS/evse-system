# scripts/test.sh
#!/bin/bash
set -e

echo "🧪 Running tests..."

poetry install
poetry run black --check src tests
poetry run ruff check src tests
poetry run mypy src
poetry run pytest -v --cov=src