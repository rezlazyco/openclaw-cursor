#!/usr/bin/env bash
# Lightweight checks that the linked plugin is loaded (requires bootstrap + CURSOR_API_KEY).
set -euo pipefail

INTEGRATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="${INTEGRATION_DIR}/scripts/compose.sh"

ENV_FILE="${INTEGRATION_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

if [[ -z "${CURSOR_API_KEY:-}" ]]; then
  echo "Set CURSOR_API_KEY in tests/integration/.env"
  exit 1
fi

echo "==> plugins list"
"${COMPOSE}" run --rm openclaw-cli plugins list

echo "==> cursor plugin enabled"
"${COMPOSE}" run --rm openclaw-cli config get plugins.entries.cursor.enabled

echo "==> default model runtime"
"${COMPOSE}" run --rm openclaw-cli config get agents.defaults.models.cursor/auto.agentRuntime

echo "==> doctor (read-only)"
"${COMPOSE}" run --rm openclaw-cli doctor --json || "${COMPOSE}" run --rm openclaw-cli doctor

echo "Smoke checks finished."
