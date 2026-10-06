#!/usr/bin/env bash
# Run docker compose from tests/integration with a stable project directory.
set -euo pipefail
INTEGRATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${INTEGRATION_DIR}"
exec docker compose "$@"
