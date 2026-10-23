# Runtime matrix

Compatibility was checked on 2026-09-12 from an empty temporary HOME and an
isolated synthetic clone. The release pins every required package; no global pi
installation or global auth is required.

| Component | Pin / support | Public source and integrity |
| --- | --- | --- |
| Node.js | `24.14.0` (tested); pi requires `>=22.19.0` | [Node releases](https://nodejs.org/en/about/previous-releases) |
| npm | `11.9.0` (shipped with Node 24.14.0) | [npm](https://www.npmjs.com/) |
| pi coding agent | `@earendil-works/pi-coding-agent@1.0.4` | `https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.0.4.tgz`; sha512 `+956nfMFHr5lDUVY/2Q4k+YzojzBuCaBXFgj0eSlXVGr7QVliVddKdc1Pz6yVg1dOlJQmb67doOVrlMsIcIdaw==` |
| pi-cursor-sdk (optional Cursor provider) | `pi-cursor-sdk@0.5.3` with `@cursor/sdk@1.0.37` | Installed from npm; **Cursor needs Node 24+** for supervised runs that load the extension. `@cursor/sdk` is proprietary-licensed (Anysphere; see `LICENSE.md` in the package and [NOTICE.md](../NOTICE.md)). |
| Playwright MCP | `@playwright/mcp@0.0.80` | `https://registry.npmjs.org/@playwright/mcp/-/mcp-0.0.80.tgz`; sha512 `FOPXHm2SvFhAQylm10jMZ35B/SR2TaMLVkavAlwoG4N2qCb5RqbvhQYcu3zmXNyxR2DW0Ooxe+9XPVt5UjKRCQ==` |
| Browser | Chrome channel, user profile under clone `.browser-data` | `/Applications/Google Chrome.app` and Playwright MCP cache detected on macOS; Linux requires a Chrome/Chromium executable or explicit install |

The pinned pi RPC surface starts in `--mode rpc`, supports `getState`, command
enumeration, prompt/reply/abort and clean stop through `RpcClient`. `-a` / `--approve`
enables project-local extension loading and `.pi/mcp.json` in non-interactive mode.
Supervised UI runs also copy `.pi/mcp.json` into each run's `PI_CODING_AGENT_DIR`, so
`job-playwright` tools load even before a saved trust decision. With `exposure: "direct"`
in `.pi/mcp.json`, pi registers tools as `mcp__job_playwright__browser_*` (no repo-root
`.mcp.json` and no third-party `mcp()` proxy). The four workspace extensions loaded
successfully from `.pi/extensions` in the synthetic clone without a model request. Pi's
built-in provider IDs are `openai`,
`anthropic`, and `google`; application-owned connections must use isolated auth
and model directories or registered aliases because native credentials are keyed
by provider ID. A local mock OpenAI-compatible endpoint verified two registered
aliases preserve distinct model IDs, base URLs, and bearer keys.
When two selected connections share a provider, the OAuth connection uses the native
provider id so pi applies its OAuth adapter; the API-key connection is aliased as
`pi-jobs-<connectionId>`. With two API-key connections, the agent keeps the native id
and the scoring connection is aliased.
The pinned MCP package's published tool inventory includes
`browser_run_code_unsafe` (the adapter's required filename contract),
`browser_navigate`,
`browser_snapshot`, `browser_click`, `browser_type`, `browser_file_upload`,
`browser_evaluate`, `browser_tabs`, `browser_take_screenshot`, and
`browser_wait_for`. The package help and inventory were verified under Node
24.14.0; the custom adapter's two same-provider aliases were also exercised
against a local mock OpenAI-compatible endpoint and sent distinct bearer keys.

macOS and Linux are the release target matrix. Windows/WSL remains unverified.

### Login detection (local metadata only)

`GET /api/providers/detected` runs `detectLogins` with injected `ProviderHostDeps`
(`home`, `env`, `platform`, `keychainProbe`, `ghProbe`). Demo mode returns `[]` without
reading disk. Production uses `os.homedir()`; tests and fresh e2e pass an isolated `HOME`.

| kind | File / probe | Parsed (no secrets in the response) | **Use this** action |
| --- | --- | --- | --- |
| `cursor-sdk` | `<home>/.cursor/sdk/auth.json` via `@cursor/sdk` `FileCredentialStore` | `apiKey` present; `email`, `apiKeyExpiresAtMs`, `backendUrl` | adopt (sign-in if expired) |
| `claude-code` | `<home>/.claude/.credentials.json` `claudeAiOauth.refreshToken`; else darwin keychain `Claude Code-credentials` (`security find-generic-password -s`, no `-w`) | presence; `subscriptionType`, `refreshTokenExpiresAt` when readable | sign-in → `anthropic` OAuth |
| `codex` | `<home>/.codex/auth.json` `tokens.refresh_token` | presence; `last_refresh` as metadata | sign-in → `openai-codex` OAuth |
| `github-cli` | `<home>/.config/gh/hosts.yml` `github.com.user` and `gh auth status -h github.com` (3 s timeout) | `user` | sign-in → `github-copilot` OAuth |
| `pi-auth` | `<home>/.pi/agent/auth.json` entries matching catalog capabilities | `api_key` or `oauth` type | adopt / adopt-scoring (`typesafe`) / sign-in |
| `env-key` | `env[catalog.apiKeyEnv]` for providers with `auth.apiKey` | non-empty env | adopt / adopt-scoring (`typesafe`) |

Detection ids: `<kind>:<provider>[:<account>]`. Adopt/sign-in persists `Connection.origin`
so repeat **Use this** returns the same connection.

### Provider matrix (authentication)

| Kind | How it authenticates |
| --- | --- |
| API-key registry providers (`openai`, `anthropic`, `google`, `openrouter`, … — see `ui/shared/providerCatalog.ts`) | API key in `.pi-jobs/pi-agent/auth.json` (alias `pi-jobs-<connectionId>`) or the provider's default env var (BYOK). `testConnection` / `listModels` use pi `getAuth` for OAuth and direct key probes for `api_key`. |
| `openai-compatible` | Optional bearer key; loopback base URLs may omit a key. Remote URLs require a stored key or env override. |
| `anthropic`, `openai-codex`, `github-copilot` | Subscription OAuth via pi `ModelRuntime.login` and Rolebound login sessions (`POST /api/providers/login`, `POST /api/connections/:id/login`, poll + `login/answer`). Stored `{type:"oauth", access, refresh, expires, …}`. |
| `cursor` | SDK browser login, SDK store adopt/import, or pasted dashboard API key (`{type:"api_key"}`). Requires **Node 24+** for supervised runs. Bills through the Cursor plan. |

Out of scope: ambient cloud providers (Bedrock, Vertex, Azure, Cloudflare).

### OAuth providers (pi flows)

| Provider | pi `login` id | Callback / device code | Stored credential (app store alias) |
| --- | --- | --- | --- |
| Claude Pro/Max | `anthropic` | Loopback `127.0.0.1:53692` (redirect URI advertised as `http://localhost:53692/callback`); races `manual_code` when the port is busy | `{type:"oauth", access, refresh, expires}` under `pi-jobs-<id>`; child run uses native `anthropic` |
| ChatGPT Plus/Pro | `openai-codex` | Loopback `localhost:1455` or device code; same silent `manual_code` fallback | `{type:"oauth", …}` native `openai-codex` in per-run auth |
| GitHub Copilot | `github-copilot` | Optional enterprise `text` prompt (auto `""` for github.com), then `device_code` | `{type:"oauth", …, availableModelIds?}` |
| Cursor account | (SDK, not pi OAuth) | Session `authUrl` in login API; `openBrowser: false` | `{type:"api_key", key}` plus connection `email` / `expiresAt` |

The Rolebound server sets `PI_OAUTH_CALLBACK_HOST=127.0.0.1` at startup (`ui/server/index.ts`)
and strips it from supervised child env. pi reads the variable when an OAuth flow module is
first imported.

**Provider terms:** pi's Anthropic and Codex flows use the same OAuth client ids as Claude Code
and the Codex CLI. Rolebound hosts pi's login in the local UI and **does not** copy OAuth
tokens from Claude Code, Codex, GitHub CLI, or pi global auth into the app store (see D1 in
the PJR-26 plan). Operating Rolebound against subscription providers is your responsibility
as the account holder.

### OAuth refresh, per-run auth, and write-back

- **Before spawn:** `prepareAgentRun` calls `resolveCredential` → pi `getAuth`, which refreshes
  near-expiry OAuth tokens into `.pi-jobs/pi-agent/auth.json` under the connection alias.
- **Per-run file:** `<runDir>/pi-agent/auth.json` holds native provider ids for OAuth entries
  (and `cursor` for Cursor). When agent and scorer share a provider but only one connection
  is OAuth, the OAuth connection keeps the **native** id and the API-key connection is written
  as `pi-jobs-<connectionId>` so pi's OAuth adapter applies to the subscription account.
  Two OAuth connections of the same provider as agent **and** scorer are rejected with
  `CONFIG_INVALID`.
- **After run:** `runManager` `beforeCleanup` reads the per-run auth file and writes an `oauth`
  entry back only when both hold: the workspace credential still equals the credential the run
  started from (same access token, refresh token and expiry — a compare-and-swap, so a
  connection signed into a different account or switched to an API key mid-run is left alone),
  and the child's credential has a later `expires`. `refreshFailedAt` is cleared only when such
  a newer credential is accepted.
- **Residual:** a hard kill after the child refreshed but before write-back can lose the rotated
  refresh token; readiness then reports `CREDENTIAL_EXPIRED` → "Sign in again".

### Cursor transcript isolation

When a run loads Cursor, `prepareAgentRun` creates `<runDir>/cursor-data` (mode `0700`), sets
`CURSOR_DATA_DIR` to that path, and deletes any inherited `CURSOR_DATA_DIR` from the child
environment. Run cleanup removes the directory with the run dir.

### Test-only seams

Browser tests start the server through `ui/server/e2e-entry.ts`, which supplies synthetic
`ProviderHostDeps` for keychain, GitHub CLI, and Node-version probes. Production starts through
`ui/server/index.ts` and does not read or honor `PI_JOBS_E2E_*` fixture controls.

| Variable | Purpose |
| --- | --- |
| `PI_JOBS_E2E_NODE_MAJOR` | Overrides reported Node major for Cursor readiness in e2e (`fresh-web-server.mjs` sets `24`) |

**Jev job scoring (Sept 2026).** Rolebound can score discovered jobs with TypeSafe's Jev decision model through OpenRouter (`typesafe/jev-1.13` or `~typesafe/jev-latest`) or a direct TypeSafe connection (`jev-latest` via `TYPESAFE_API_KEY`). Jev is scoring-only: it cannot drive the apply agent. It returns numeric fit and yes/no signals with probabilities, not free-form reasons; instructions are taken literally and it does not count or do date math, which is acceptable for fit scoring.
