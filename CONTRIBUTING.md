# Contributing

By contributing you agree that your contributions are licensed under the project's
[MIT License](LICENSE).

Thank you for helping improve Rolebound. This repository is a local, user-supervised
workspace (internal name `pi-jobs`): product code is tracked, while profiles, credentials, resumes, and
application records stay gitignored on each machine.

## Prerequisites

See [docs/runtime-matrix.md](docs/runtime-matrix.md) for pinned versions. Local
release checks use **Node 24.14.0** (see matrix). GitHub Actions runs the same checks on
macOS 15 and Ubuntu 24.04 (`.github/workflows/ci.yml`); see
[docs/release-report.md](docs/release-report.md) for the latest dated remote results.

Install dependencies once:

```bash
npm ci
npm run setup
npm run build
```

## Verification commands

Run these from the repository root after `npm ci`:

| Command | Purpose |
| --- | --- |
| `npm run release:audit -- --candidate "$PWD"` | Release scanner / allowlist (fails on live workspace — expected) |
| `npm run workspace-test` | Workspace resolver tests |
| `node --test scripts/release-tools.test.mjs` | Export tooling tests |
| `npm run typecheck` | Root extension library types |
| `npm run typecheck --workspace ui` | UI server + client types |
| `npm test` | Root Vitest (adapter logic) |
| `npm test --workspace ui` | UI unit tests |
| `npm run build` | Production UI build |
| `npm run runtime-smoke` | Extension load smoke (isolated clone) |
| `npm run server-smoke` | API + SPA smoke (ephemeral port) |
| `npm run demo-smoke` | Demo mode: no external calls, fake supervised run |
| `npm run browser-test` | Playwright journeys (port **14747**, not 4747) |

Browser tests require Chromium. Locally:

```bash
npx playwright install chromium --with-deps
npm run browser-test
```

Export verification (run on a **clean export tree**, before `npm ci` mutates it):

```bash
npm run release:export -- --output "$RELEASE_DIR"
npm run release:audit -- --candidate "$RELEASE_DIR"
cd "$RELEASE_DIR" && npm ci && npm run build && npm run demo-smoke
```

Use any empty directory for `$RELEASE_DIR`.

## Test hygiene

- Use synthetic fixtures in disposable directories; remove them after tests.
- Do not make network requests to employers or paid services in automated tests.
- Do not commit `profile.md`, `credentials.json`, `settings.json`, resumes, or
  screenshots.
- Run `scripts/audit-personal-data.sh` before publishing a fork.

## Upgrades

User data lives outside tracked files. Upgrading product code is:

```bash
git pull
npm ci
npm run build
```

Your gitignored workspace files are preserved. Re-run `npm run doctor` after upgrades
to confirm browser, profile, and model readiness.
