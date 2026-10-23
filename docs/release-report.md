# Local release verification

## 2026-10-22 — Current status (supersedes older "pending" notes below)

| Item | Status |
| --- | --- |
| License | **MIT**, chosen by the owner on 2026-10-22. `LICENSE` and `NOTICE.md` are in the export allowlist. |
| Destination | <https://github.com/bbarney7/rolebound>, **private** as of 2026-10-22. Not yet published. |
| Remote CI | Last green runs on `main`: 2026-10-07 (PR #1) and 2026-10-08 (PR #2, PR #3). Every run since 2026-10-14 (chat-first merge onward) was **not started** by GitHub: "recent account payments have failed or your spending limit needs to be increased". No remote result exists for current `main`. |
| Local unit tests | On `main` at `d50a540` (agent-instructions merge), macOS, Node 24: root **504 passed**, UI/server **1270 passed**, both typechecks clean. |
| Real-provider and live-application pilot | Not run (PJR-23 Phase B, needs owner authorization). |

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
