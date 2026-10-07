# OpenClaw Cursor

OpenClaw agent harness and model provider plugin backed by [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript).

It mirrors the bundled Codex plugin shape:

- **Provider** `cursor` — Cursor model catalog (live via `Cursor.models.list()`, with offline fallback)
- **Harness** `cursor` — runs prepared OpenClaw turns through Cursor agents (`Agent.create` / `Agent.resume` / `agent.send`)
- **Session binding** — maps OpenClaw session generations to durable Cursor `agentId` values

## Install

Requires OpenClaw **≥ 2026.6.11** (see `openclaw.install.minHostVersion` in `package.json`).

```bash
openclaw plugins install @rezlazyco/openclaw-cursor
# update:
# openclaw plugins install --force @rezlazyco/openclaw-cursor
```

### Local checkout

```bash
npm run build
openclaw plugins install /path/to/openclaw-cursor
```

Ensure the Cursor API key is available to the gateway process:

```bash
# preferred: OpenClaw state-dir env (gateway loads ~/.openclaw/.env)
echo 'CURSOR_API_KEY=crsr_…' >> ~/.openclaw/.env

# alternative: OpenClaw auth profile
openclaw models auth login --provider cursor --method api-key --set-default
```

Create a key in the [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api). Do not commit the key or put it in shared project env files unless you intend every process to inherit it.

**Required:** pin the Cursor SDK harness, or OpenClaw falls back to
`OpenClaw Default` and calls `https://api.cursor.com/chat/completions` (404):

```bash
openclaw config set agents.defaults.models \
  '{"cursor/composer-2.5":{"agentRuntime":{"id":"cursor"}}}' \
  --strict-json --merge
openclaw config set agents.defaults.model.primary cursor/composer-2.5
```

(`--merge` only adds/updates that model entry; it does not wipe other models.)

Restart the gateway after install/enable.

## Proxy

`@cursor/sdk` does not expose a `proxyUrl` setting. Point the **gateway process**
at your proxy with standard environment variables. On Node 22+, set
`NODE_USE_ENV_PROXY=1` so `fetch` uses `HTTP_PROXY` / `HTTPS_PROXY`. Add hosts
that must bypass the proxy to `NO_PROXY` (comma-separated hostnames or CIDRs).

If the proxy mishandles HTTP/2, enable HTTP/1.1 for the local Cursor agent:

```bash
export HTTP_PROXY=http://user:pass@host:port
export HTTPS_PROXY="$HTTP_PROXY"
export NO_PROXY=localhost,127.0.0.1
export NODE_USE_ENV_PROXY=1

openclaw config set plugins.entries.cursor.config.local.useHttp1ForAgent true
openclaw gateway restart
```

Check that the gateway inherited the variables and can reach Cursor:

```bash
printenv HTTP_PROXY HTTPS_PROXY NO_PROXY NODE_USE_ENV_PROXY
curl -I https://api.cursor.com
```

## Publish

### GitHub Release → npm (recommended)

1. Bump `version` in `package.json` and commit to `main`.
2. Create a [GitHub Release](https://github.com/rezlazyco/openclaw-cursor/releases/new) with tag **`vX.Y.Z`** (must match `package.json`, e.g. `v0.1.8` for `0.1.8`).
3. On [npm](https://www.npmjs.com/), open the package (or your account) → **Trusted Publisher** → GitHub Actions:
   - **Organization or user:** `rezlazyco`
   - **Repository:** `openclaw-cursor`
   - **Workflow filename:** `publish.yml`
   - **Environment:** leave empty unless you use a GitHub Environment
4. Publish the release. Workflow [`.github/workflows/publish.yml`](.github/workflows/publish.yml) runs `npm publish` via OIDC (no long-lived `NPM_TOKEN`).

Provenance is attached automatically for public repos when using trusted publishing.

### Manual publish

```bash
npm login
npm publish
# prepublishOnly runs build automatically
```

## Config

```json5
{
  plugins: {
    allow: ["cursor"],
    entries: {
      cursor: {
        enabled: true,
        config: {
          runtime: "local", // or "cloud"
          apiKeyEnv: "CURSOR_API_KEY",
          local: {
            settingSources: [], // keep ambient Cursor settings out of the service path
            sandboxEnabled: false,
            autoReview: false, // Cursor Auto-review classifier for local tool calls
            useHttp1ForAgent: false, // true behind HTTP proxies that break HTTP/2
          },
          cloud: {
            repoUrl: "https://github.com/org/repo",
            startingRef: "main",
            autoCreatePR: false,
            skipReviewerRequest: true,
          },
        },
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: "cursor/composer-2.5" },
      models: {
        "cursor/composer-2.5": {
          agentRuntime: { id: "cursor" },
        },
      },
    },
  },
}
```

Pin additional Cursor models the same way (model ids from `/cursor models`):

```bash
openclaw config set agents.defaults.models \
  '{"cursor/auto":{"agentRuntime":{"id":"cursor"}}}' \
  --strict-json --merge
```

Equivalent JSON shape:

```json5
{
  agents: {
    defaults: {
      models: {
        "cursor/composer-2.5": {
          agentRuntime: { id: "cursor" },
        },
      },
    },
  },
}
```

## MCP

OpenClaw `mcp.servers` are projected into Cursor SDK `mcpServers` on every
create/resume/send (inline MCP is not persisted across resume).

```json5
{
  mcp: {
    servers: {
      outlook: {
        command: "node",
        args: ["/opt/outlook-mcp/dist/index.js"],
      },
      atlas: {
        transport: "streamable-http", // mapped to Cursor http
        url: "https://atlas.example.com/mcp",
        headers: { Authorization: "Bearer ..." },
      },
    },
  },
}
```

Optional per-server agent filter (Cursor-only):

```json5
{
  mcp: {
    servers: {
      atlas: {
        url: "https://atlas.example.com/mcp",
        transport: "streamable-http",
        cursor: { agents: ["main"] },
      },
    },
  },
}
```

Notes:
- Explicit `headers` override OAuth-derived `Authorization` when both are present.
- OAuth MCP without stored tokens is still skipped.
- Changing the projected MCP set invalidates session resume (`compatKey` includes an MCP fingerprint).
- OAuth MCP servers (`auth: "oauth"`) use tokens from OpenClaw's `~/.openclaw/mcp-oauth/` store when explicit headers are not set.

## Runtime notes

- OpenClaw messaging tools (`message`, `sessions_send`, …) are bridged as Cursor `customTools` (local). Successful sends set `didSendViaMessagingTool` on the attempt result.
- **Background jobs** (local runtime): when `local.backgroundJobs.enabled` is true (default), the Cursor agent gets `openclaw_background_job` (`spawn` / `status` / `list` / `cancel`). The system prompt instructs the model to classify each turn: small tasks stay inline; large or async work must call `spawn` first (full `task` text) and reply with the real `jobId` from the tool. On completion, `local.backgroundJobs.notifyOnComplete` pushes a user-visible message via OpenClaw `sessions_send` (same `sessionKey`, any channel including webchat), then the channel `message` tool when routing fields are present, then `session.workflow.scheduleSessionTurn` (`deliveryMode: announce`) when the host allows it (official bundled install). In-memory jobs are lost on gateway restart unless `local.backgroundJobs.persistJobs` is enabled (active runs are not resumed).
- Owner tool `cursor_agents` lists/gets Cursor agents and can attach one to the current OpenClaw session (`action: resume`, `attach: true`).
- Session binding mutations are fenced with binding leases to avoid concurrent overwrite across workers/turns.
- User/assistant/tool messages are dual-written into the OpenClaw session transcript (best-effort).
- Prompt images from OpenClaw are forwarded to `agent.send({ text, images })`.
- After OpenClaw compaction, the Cursor `agentId` binding is adopted onto the new session generation.
- Harness `compact` summarizes the bound Cursor transcript via a one-shot `Agent.prompt` (Cursor has no native compact RPC) and returns that summary to OpenClaw.
- Harness `runSideQuestion` uses an isolated one-shot agent so side questions do not pollute the bound conversation.
- Cursor native shell/edit is not gated by OpenClaw exec approvals; set `local.autoReview: true` to enable Cursor's Auto-review classifier when the backend supports it.
- Channel conversation binding: `/cursor bind` → host approval → inbound messages are claimed by the Cursor plugin (`inbound_claim`) and answered by the bound Cursor agent. Detach with `/cursor detach`. Bound local turns also project OpenClaw tools (`message`, `sessions_send`, …) as Cursor `customTools`.
- Session bindings use stable `session-key:{agent}:{digest(sessionKey)}` keys when `sessionKey` is present, so compaction rotates `sessionId` in-place via `adoptSessionGeneration`.
- `/cursor stop` cancels the active Cursor run (`run.cancel`). Steer is not available in Cursor SDK.
- Attempt results include `attemptUsage` when the SDK reports token usage.

### `/cursor` CLI

| Command | Description |
|---------|-------------|
| `bind [agent-id] [--cwd] [--model]` | Attach channel conversation to a Cursor agent |
| `detach` | Remove conversation binding |
| `binding` | Show current conversation binding |
| `resume <agent-id>` | Point the OpenClaw session harness at an existing Cursor agent |
| `agents` / `threads` | List recent Cursor agents (`Agent.list`) |
| `agent <agent-id>` | Agent metadata + recent messages |
| `runs <agent-id>` | Recent runs for an agent |
| `models` | Models available to your API key |
| `mcp` | MCP servers projected from OpenClaw config |
| `diagnostics` | Auth, bindings, MCP fingerprint |
| `stop` | Cancel active run |
| `status` | Harness + session binding summary |

For non-bundled installs, enable conversation hooks:

```json5
{
  plugins: {
    entries: {
      cursor: {
        hooks: { allowConversationAccess: true },
      },
    },
  },
}
```

## Develop

```bash
npm install
npm run build
npm run typecheck
npm test
```

`devDependencies` pull `openclaw` from npm for tests and tooling — a separate OpenClaw git checkout is not required.

### Integration (Docker)

For a local OpenClaw gateway with this plugin link-installed, secrets in `tests/integration/.env`, and smoke checks:

```bash
cp tests/integration/.env.example tests/integration/.env
# set CURSOR_API_KEY
npm run test:integration:bootstrap
npm run test:integration:smoke
```

See [tests/integration/README.md](tests/integration/README.md).
