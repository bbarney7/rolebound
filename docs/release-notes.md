# Release notes

## 0.1.0 — first public release (unreleased)

The first version of Rolebound meant for people other than its author. Everything runs on
your machine; there is no hosted service.

### What you get

- **Chat-first app.** Talk to the agent at `/`. Drop in a resume and it fills your profile;
  ask it to find, score or apply to jobs. Tool results show up as cards in the transcript,
  and questions it needs answered appear as inline prompts.
- **Workspace drawer** for the forms: profile, resumes and addresses, job search
  preferences and companies to watch, agent instructions, applications, site logins,
  settings and the setup checklist.
- **Bring your own model.** Detects AI accounts you are already signed into (Cursor,
  Claude, ChatGPT/Codex, GitHub Copilot, pi) and offers one-click sign-in or a pasted API
  key. Separate models for chat, applying and scoring.
- **Agent instructions.** Plain-English standing rules for applying, finding/scoring and
  chat, editable on a page or by asking the chat.
- **Discovery** from public Greenhouse, Ashby and Lever boards, with LLM fit scores and a
  review step before anything is queued.
- **Supervised applying** in a real Chrome profile, with a fast Greenhouse path that reads
  the form schema from Greenhouse's public API and generates fill/submit/verification-code
  scripts (switch off with `PI_JOBS_ATS_ADAPTERS=0`).
- **ATS account management** for sites that require a login per company.
- **Safety rails in code:** one-time auto-submit acknowledgement, stop that actually stops,
  one application per ten minutes, CAPTCHA solving off by default with spend caps, and the
  submission boundaries listed in [SECURITY.md](../SECURITY.md).
- **Durable local storage:** cross-process locks, atomic writes, fail-closed reads of
  corrupt files, backups before every migration, `npm run doctor`, `backup` and `restore`.
- **Demo mode** (`npm run demo`) with synthetic data that never contacts employers or
  model providers.

### Known limitations

- macOS and Linux only; Windows/WSL are unverified.
- The private predecessor (pi-jobs) submitted real applications for the author, but
  Rolebound's own fresh-user pilot with a real provider and a live posting (PJR-23 Phase B)
  has not been run yet.
- Only Greenhouse has a schema-driven fast path; other ATSs are driven field by field.
- Remaining submission-boundary gaps (notably `bash` and terminal `pi` sessions) are listed in
  [SECURITY.md](../SECURITY.md#what-stops-a-submission).

### License

MIT. Third-party notices are in [NOTICE.md](../NOTICE.md).
