# Local release verification

## 2026-10-23 — First public release (current status)

| Item | Status |
| --- | --- |
| License | **MIT** (`LICENSE`); third-party notices in `NOTICE.md`. |
| Repository | Public at <https://github.com/bbarney7/rolebound> since 2026-10-23, published as a single initial commit. Earlier development history is kept privately; commit and PR references in the historical sections below point into that history. |
| Remote CI | The first public run stopped at the dependency audit: advisories published after the last green run cover `vite` up to 8.3.2, `vitest`/`@vitest/mocker` before 4.1.12, and `ip-address` up to 10.7.3. Fixed by moving to `vite` 8.3.4 (pinned for every dependent through a root override), `vitest` 4.1.12 and `ip-address` 10.7.4. |
| Local verification | macOS, Node 24.14.0, npm 11.9.0, after the upgrade: dependency audit passes with no findings; root **504** and UI/server **1270** unit tests; both typechecks; production build; demo smoke; workspace (49), lifecycle (12) and release-tool tests; desktop browser suite **192 passed** (44 skipped by design) plus fresh-onboarding suite **12 passed**. A clean `npm ci`, build, demo smoke and unit run on the reviewed export (498 files, `release:audit` clean) also passed. |
| Real-provider and live-application pilot | Not run yet. Automated checks use fictional fixtures, a fake model and a local fake ATS only. |

The results below are historical and describe the commits they name.

---

## 2026-10-09 — PJR-26 provider autodetect and sign-in

Fresh-user onboarding e2e (isolated `HOME`, fixture credentials only) records measured
interaction counts for the connection step:

| Path | User interactions (budget) |
| --- | --- |
| Detected Cursor SDK → **Use this** | 2 (≤ 2) |
| Detected pi Anthropic API key → **Use this** | 2 (≤ 2) |
| Detected Claude Code → **Use this** → OAuth pending | 2 (session only; no provider network in CI) |
| Full onboarding via **Paste a key instead** (loopback OpenAI-compatible) | 9 |

See `ui/e2e/fresh-onboarding.spec.ts` and the browser-test log lines
`fresh onboarding cursor-sdk interactions`, `pi-anthropic`, `claude-code`, and
`fresh onboarding loopback interactions`.

---

## 2026-09-14 — Rolebound redesign

The coordinator independently verified a clean source export with Node 24.14.0 on macOS after the final UI and dependency changes.

| Check | Result |
| --- | --- |
| Clean `npm ci`, typechecks, production build | Pass |
| Root unit tests | 288 passed |
| UI/server unit tests | 612 passed |
| Browser journeys, responsive/visual gates, brand and race regressions | **91 passed** |
| Unfiltered axe (9 routes × light/dark) | **0 violations on 18 surfaces** |
| Workspace and release-tool regression tests | 11 passed |
| Real pi RPC/extensions, provider aliases, MCP filename execution | Pass |
| Server health/history fallback/shutdown and isolated demo smoke | Pass |
| Dependency audit | 0 known vulnerabilities; compatible qs 6.16.0 patch |
| Seven protected original files | All hashes unchanged |

The new interface replaces the sidebar with a horizontal workspace, introduces Rolebound's original vector identity and local licensed fonts, and rebuilds the home, opportunities, profile, setup and settings surfaces. Review corrected duplicate actions, inconsistent accessible labels, clipped mobile navigation, status contrast, heading hierarchy and stale opportunity details. Delayed-response and failed-fetch/retry regressions run across all five journey viewport/theme projects.

The final source candidate is assembled with the reviewed allowlist and fresh Git history. Credentials, applicant files, browser state, screenshots and generated test artifacts are excluded. Publication and license decisions were pending at the time (see the 2026-10-22 status above). No paid provider/CAPTCHA calls or employer submissions were used.


---

## 2026-09-13 — Public release baseline

Verified on 2026-09-13 with Node 24.14.0 on macOS. This report covers a fresh source export, not publication of the original workspace or its history.

## Independent verification

The coordinator ran these checks against the exported source after the final implementation changes:

| Check | Result |
|---|---|
| Source export audit | Pass; reviewed allowlist, no secret-pattern/history findings |
| `npm ci` | Pass |
| Root and UI typechecks | Pass |
| Root unit tests | 288 passed |
| UI/server unit tests | 612 passed |
| Workspace migration/restore tests | Pass |
| Release scanner/export regression tests | Pass |
| Production build | Pass |
| Real pi RPC/extensions, independent provider aliases, MCP filename execution | Pass |
| Server health/history fallback/shutdown smoke | Pass |
| Demo readiness, external-call blocking, fake run reply/finish | Pass |
| Browser journeys and visual gates | 71 passed |
| Normal-mode BYOK browser creation | Pass; stored key not echoed, input cleared |
| Protected original files | All seven saved hashes unchanged |

Browser coverage includes onboarding acknowledgement without run creation, Discover/targets/promote, supervised fake application, synthetic receipt, hiring-stage persistence, resume upload/default byte identity, address revisions, reply drafts, navigation, keyboard access, axe checks, and light/dark layouts at 1440/1024/768/390 pixels. Screenshots and traces are generated locally and excluded from source exports.

The separate empty-home walkthrough passed documented setup, build, start/shutdown, doctor blocker reporting, and empty/populated demo commands. No paid model/CAPTCHA request or employer submission was used for verification.

## Release scope and pending decisions (as of 2026-09-13; superseded by the 2026-10-22 status above)

- **License remains pending owner selection.** This candidate does not claim an open-source license.
- No GitHub destination has been selected, and nothing has been pushed publicly. Replace the documented clone URL after choosing the destination.
- CI is configured for Linux/macOS; remote CI has not been run. Local macOS verification is recorded above. Native Windows is not certified.
- Demo application receipts are explicitly synthetic and are not employer confirmations.
- The final candidate has fresh source-only Git history. Never publish the original private workspace history.

See [README](../README.md) for setup and [the ticket ledger](../Codex-info/plans/2026-09-12-public-release/progress.md) for scope and review history.
