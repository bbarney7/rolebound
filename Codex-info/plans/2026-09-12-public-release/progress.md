# Implementation and verification ledger

Updated 2026-09-13. The original checkout remains protected. Product work is in an isolated checkout on `codex/public-release`; no public push has occurred.

## Execution policy

All current implementation and corrective work uses Cursor CLI `composer-2.5`, never fast mode. The coordinator verified model initialization events, reviewed source and rendered screens, independently ran tests, and owns Git/release assembly. Earlier work used cheaper Codex agents before the owner switched execution to Cursor.

## Ticket status

| Tickets | Status / evidence |
|---|---|
| T01 | Export allowlist, private-file/history audit, fail-closed regressions implemented. Generated browser traces rejected in candidates and omitted from exports. Fresh export audit passes; final source candidate uses a fresh Git history. |
| T02 | Independently verified real pi RPC/extensions, isolated provider aliases, and browser MCP filename execution, including from an exported checkout. |
| T03 | Versioned initialization, migrations/backups, rollback/restore and symlink checks implemented and tested. |
| T04–T07 | Config schema, BYOK connections, separate agent/scorer snapshots, native metadata, scorer retries/cancellation/CAS, optional CAPTCHA/email and manual verification implemented. Reviewed defects corrected and regression-tested. |
| T08 | Loopback Host/Origin policy, CSRF client/server, secret handling and evidence traversal protections implemented/tested. |
| T09 | Root setup/build/start/dev/doctor/demo/restore commands implemented. Empty-home export walkthrough passes. Demo uses a dedicated fake runtime and synthetic artifacts. |
| T10–T11 | Warm neutral/green visual system, modular shell, real routes, semantic navigation and responsive layouts implemented; rendered desktop/mobile review performed. |
| T12 | Setup and readiness implemented. Explicit first-use acknowledgement API and browser journey verified; Setup enables applying only after the explicit action, without starting a run. |
| T13 | Profile editing, address revisions, PDF upload/default selection and runtime resolution implemented/tested; independent normal-mode BYOK browser creation also passes. |
| T14 | Targets CAS editing, shared parser, Discover filtering/detail/dismiss/restore/promote and bounded duplicate indexing implemented/tested. |
| T15–T17 | Today/Queue, supervised run requests/draft preservation, applications/filter/stage/evidence workflows implemented. Fake browser workflow verifies receipt and stage persistence. |
| T18–T19 | Light/dark and 1440/1024/768/390 visual coverage, axe and keyboard checks. Independent exact-export browser suite: 71/71 passed, including acknowledgement, keyboard, axe and measured mobile-header/layout gates. |
| T20 | CI matrix and exact-export verification configured. Local checks pass; remote CI has not been executed. |
| T21 | README, contributor/security/runtime docs synchronized. Public license and destination remain owner decisions; native Windows is not certified. |
| T22 | Fresh exports independently audit/install/build/run successfully. Locally verified source candidate assembled with fresh Git history. Publication remains pending license/destination; no publication. |

## Independent evidence

- Root tests: 288 passed. UI tests: 612 passed independently in the exact exported checkout.
- Config/router, workspace migration/restore, release scanner and protected-path checks pass.
- Exported checkout: audit, npm ci, production build, both typechecks, real pi/MCP runtime smoke, server smoke, demo smoke, workspace/release tests, and 71 browser tests pass independently.
- Normal-mode browser BYOK creation: app-store credential created, input cleared, API response contains no key. Only a fictional key and loopback endpoint were used.
- All seven protected original file hashes match.
- No employer submission, paid solver/model call, global credential import, or public push was used for acceptance.

## Rework enforced by review

Corrected missing-scorer fallback, metadata global-auth reads, snapshot symlink handling, scoring frontmatter corruption and mismatched locks, falsely in-flight cancellation tests, migration rollback gaps, CSRF integration, fake demo claims without persisted results, non-UUID demo configuration, quadratic discovery I/O, nullable-revision overwrite, hidden mobile routes, conditional no-op browser assertions, stale asset builds, setup spacing and misleading empty-state copy. Passing unit tests alone did not close these findings.

## Remaining release decisions

License selection remains pending. A public repository destination is needed before replacing the clone URL placeholder. Remote CI/Linux matrix results must be recorded after a repository exists; native Windows remains unsupported until verified. These limitations must stay explicit in the final report.
