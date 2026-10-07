# Integration testing (Docker)

Run OpenClaw in Docker with this repository **link-installed** as the `cursor` plugin. Use this for manual checks and smoke scripts against a real gateway.

Unit tests stay in the repo root (`npm test` / Vitest). This folder is only for the Docker stack.

## Prerequisites

- Docker Compose v2
- `CURSOR_API_KEY` from [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api)

## Setup

```bash
cp tests/integration/.env.example tests/integration/.env
# edit tests/integration/.env — set CURSOR_API_KEY (and proxy vars if needed)
npm run test:integration:bootstrap
```

Bootstrap builds `dist/`, starts the gateway, runs `plugins install --link /plugin`, and applies the Cursor harness config from the main README.

## Day-to-day commands

| Command | Purpose |
|---------|---------|
| `npm run test:integration:up` | Start gateway only |
| `npm run test:integration:down` | Stop stack |
| `npm run test:integration:logs` | Follow gateway logs |
| `npm run test:integration:cli -- plugins list` | OpenClaw CLI in the stack |
| `npm run test:integration:smoke` | Plugin loaded + config sanity checks |
| `npm run test:integration:bootstrap` | Rebuild plugin + reinstall / reconfigure |

Open the control UI at `http://127.0.0.1:18789/` (port overridable via `OPENCLAW_GATEWAY_PORT` in `.env`).

After changing plugin code, run `npm run build` and `npm run test:integration:bootstrap` (or restart the gateway if only config changed).

### Background jobs (manual)

With `plugins.entries.cursor.config.local.backgroundJobs.enabled` (default `true`), ask the Cursor agent for a long task and confirm it calls `openclaw_background_job` with `action=spawn`, replies with a `jobId`, and `action=status` reports progress. Smoke scripts do not assert this yet.

## Local state

- `tests/integration/.openclaw-state/` — gateway config and plugin install metadata (gitignored)
- `tests/integration/.openclaw-workspace/` — agent workspace (gitignored)

Remove these directories to reset the stack.

## Proxy

Set `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and `NODE_USE_ENV_PROXY=1` in `tests/integration/.env`. For HTTP/2 issues, set `OPENCLAW_CURSOR_USE_HTTP1=1` before bootstrap.

## Image version

Default image is `ghcr.io/openclaw/openclaw:2026.6.11` (aligned with `openclaw.install.minHostVersion`). Override with `OPENCLAW_IMAGE` in `.env`.
