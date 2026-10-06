#!/usr/bin/env bash
# Build the plugin, start the gateway, link-install this repo, apply Cursor config.
set -euo pipefail

INTEGRATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${INTEGRATION_DIR}/../.." && pwd)"
COMPOSE="${INTEGRATION_DIR}/scripts/compose.sh"
CONFIG_FILE="${INTEGRATION_DIR}/.openclaw-state/openclaw.json"

ENV_FILE="${INTEGRATION_DIR}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Missing ${ENV_FILE}. Copy tests/integration/.env.example to tests/integration/.env and set CURSOR_API_KEY."
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

if [[ -z "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  OPENCLAW_GATEWAY_TOKEN="$(openssl rand -hex 24)"
  echo "OPENCLAW_GATEWAY_TOKEN=${OPENCLAW_GATEWAY_TOKEN}" >> "${ENV_FILE}"
  export OPENCLAW_GATEWAY_TOKEN
  echo "==> Generated OPENCLAW_GATEWAY_TOKEN in tests/integration/.env (paste into Control UI if prompted)"
fi

echo "==> Building plugin at ${REPO_ROOT}"
(cd "${REPO_ROOT}" && npm run build)

if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "==> Initial OpenClaw gateway config"
  "${COMPOSE}" run --rm --no-deps --entrypoint node openclaw-gateway dist/index.js config set --batch-json \
    '[{"path":"gateway.mode","value":"local"},{"path":"gateway.bind","value":"lan"},{"path":"gateway.controlUi.allowedOrigins","value":["http://localhost:18789","http://127.0.0.1:18789"]}]'
  "${COMPOSE}" run --rm --no-deps --entrypoint node openclaw-gateway dist/index.js config set gateway.auth.token "${OPENCLAW_GATEWAY_TOKEN}"
else
  echo "==> Syncing gateway.auth.token from .env"
  "${COMPOSE}" run --rm --no-deps --entrypoint node openclaw-gateway dist/index.js config set gateway.auth.token "${OPENCLAW_GATEWAY_TOKEN}"
fi

echo "==> Starting OpenClaw gateway"
"${COMPOSE}" up -d openclaw-gateway

echo "==> Waiting for gateway HTTP"
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/"; then
    break
  fi
  sleep 2
done
curl -fsS -o /dev/null "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/"

echo "==> Linking plugin from /plugin"
"${COMPOSE}" run --rm openclaw-cli plugins install --link /plugin

echo "==> Applying Cursor plugin + harness config"
"${COMPOSE}" run --rm openclaw-cli config set plugins.allow '["cursor"]' --strict-json
"${COMPOSE}" run --rm openclaw-cli config set plugins.entries.cursor.enabled true --strict-json
"${COMPOSE}" run --rm openclaw-cli config set \
  agents.defaults.models \
  '{"cursor/auto":{"agentRuntime":{"id":"cursor"}}}' \
  --strict-json --merge
"${COMPOSE}" run --rm openclaw-cli config set agents.defaults.model.primary cursor/auto

if [[ "${OPENCLAW_CURSOR_USE_HTTP1:-0}" == "1" ]]; then
  "${COMPOSE}" run --rm openclaw-cli config set plugins.entries.cursor.config.local.useHttp1ForAgent true
fi

echo "==> Restarting gateway to load plugin"
"${COMPOSE}" restart openclaw-gateway
sleep 5
curl -fsS -o /dev/null "http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/"

echo ""
echo "Gateway UI: http://127.0.0.1:${OPENCLAW_GATEWAY_PORT:-18789}/"
echo "Gateway token: ${OPENCLAW_GATEWAY_TOKEN} (also in tests/integration/.env)"
echo "CLI: npm run test:integration:cli -- <args>"
echo "Smoke: npm run test:integration:smoke"
