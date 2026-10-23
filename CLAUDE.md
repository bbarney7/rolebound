# Local workspace guidance

This repository is a local, user supervised workspace. Keep changes scoped to
the checkout and preserve user files, templates, and existing state. Read the
project instructions before editing code, and run the documented checks after
changes.

End-user install, supported UI commands, and provider configuration are documented
in `README.md`. Automatic submission policy and enforced boundaries are in
[SECURITY.md](SECURITY.md#automatic-submission). This file is contributor and
agent-runtime guidance for the checkout.

In this checkout, pi's own `write`/`edit` tools cannot modify Rolebound code or workspace state (`STATE_DIRECT_WRITE`); contributors edit the code with their editor or another coding agent.

## Working practices

- Keep credentials, personal profiles, resumes, screenshots, and application
  records out of version control.
- Use temporary synthetic fixtures for tests and remove them after the test.
- Do not make network requests to employers or paid services in automated tests.
- Preserve unknown Markdown sections and existing state fields when writing data.
- Use atomic writes and retain recoverable backups for migrations. Follow
  [docs/workspace.md](docs/workspace.md) for locks, fail-closed corruption,
  `complete_application`, restore, and doctor `--repair`. Backups are
  secret-bearing; Windows is unsupported.
- Treat browser automation as supervised work; stop when a human decision is
  required and report the exact next action.

## Verification

Run the root and UI typechecks, the relevant unit tests, and the production
build. Validate paths and input at the boundary, redact secrets from errors and
logs, and document any platform-specific limitation in the runtime matrix.
