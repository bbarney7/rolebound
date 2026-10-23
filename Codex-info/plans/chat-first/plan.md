# Chat-first Rolebound

Owner direction, 2026-10-14: chat-first now; the current form-first design is rejected outright. The process was too heavy, so this plan replaces PJR-27, PJR-28 and PJR-29 with one build:

- One short plan (this file). No plan-review loop.
- Two slices: A (backend) starts now; B (frontend) starts once the owner approves a mockup.
- One code review at the end. Merge when local tests and typechecks are green.
- Base: `codex/pjr-26-provider-autodetect` (b26666d, includes PJR-23). PRs #4, #5 and this branch merge together.

## Goal

You open Rolebound and land in a chat. If no provider is connected, the first card in the chat is the PJR-26 detection/sign-in card. You drop a resume and get a filled profile back, with the agent asking only for what the resume can't supply. You type "find me roles at Anthropic" and get job cards you can promote or reject. You say "apply to the top one" and watch the run as progress cards. Forms (profile, queue, targets, accounts, settings, applications) still exist, opened from a drawer or from a card's "Edit in form".

## Key fact that keeps this small

A run is already a multi-turn pi RPC session: `runManager.reply()` sends `prompt`/`steer`, the run sits in `waiting` between turns, `/events` replays a run's events on reconnect, and `tool_start`/`tool_end` events already stream. The extensions already provide gather, score, promote, reject, targets, accounts and apply. A chat is a run that starts from the user's first message instead of a slash command. Because it is one long-lived session, the agent gathers, scores and applies with its own tools, so no "start another run" tool is needed.

## Slice A: backend (Codex)

1. **`chat` run kind.** Add `"chat"` to `RunKind`/`RUN_KINDS` and a `chat` behaviour in `runManager.ts`. `POST /api/runs {kind:"chat", message}` spawns pi and sends `message` as the first prompt (no slash command). Later messages use the existing `POST /api/runs/:id/reply`. A chat never finishes on its own after `agent_end`; it waits for the next message and ends only on abort/finish. A page reload restores the conversation through the existing event replay. A server restart may start a fresh chat (note it in docs). Set `PI_JOBS_RUN_KIND=chat` in the child env.
2. **Chat prompt.** When `PI_JOBS_RUN_KIND=chat`, append a short system-prompt section: you are Rolebound's assistant inside a chat UI; be brief; act through tools; when a resume is attached call `resume_extract_text` then write the profile with `profile_update_section`, then ask only for facts the resume can't supply (work authorization, target locations, salary, address); never invent facts. Other run kinds must get a byte-identical prompt to today.
3. **Workspace tools**, in a new top-level extension `.pi/extensions/workspace-tools.ts` (helpers and tests under `.pi/extensions/lib/`; pi loads every top-level `.ts` as an extension):
   - `profile_read`: the profile as Markdown plus which sections are present and which still hold template placeholders.
   - `profile_update_section(section, markdown)`: replace one `##` section, creating it if absent. Edit raw text; never re-render from the lossy `parseProfile` model.
   - `queue_add_url(url, company?, title?, location?)`: write a queue file the same way the UI's queue add does.
   - `resume_add(path, setDefault?)`: copy an uploaded file into `resumes/` and optionally make it the default, the same way the UI does.
   - `resume_extract_text(path)`: local text extraction for PDF/DOCX/TXT/MD with no network. Pick a pure-JS PDF/DOCX extractor that passes `npm run audit:deps` on Node 22 and 24.
   Use the same writers and the same cross-process locks the UI uses (`ui/server/profileWriter.ts`, `queueWriter.ts`, the PJR-12 storage/lock primitives). If `ui/server/lock.ts` is in-process only, move the shared piece into `.pi/extensions/lib/` and have both sides import it. Don't loosen the `STATE_DIRECT_WRITE` guard; these tools are the sanctioned write path. Existing tools (`add_target`, `list_targets`, `gather_all`, `score_discovered`, `promote_to_queue`, `reject_discovered`, `list_queued_jobs`, account and apply tools) stay as they are.
4. **Structured results for cards.** New tools return `details: { card, ... }` where `card` is one of `job-list`, `profile-diff`, `run-progress`, `application`, `connection`. Add the same `details` to `gather_all`, `score_discovered`, `promote_to_queue` and `update_application_state` results where cheap. Extend the `tool_end` run event with an optional `details` field that passes through the existing redaction (`redact.ts`, `maskUnreadableChildEvent`). Put the card types in `ui/shared/types.ts`.
5. **Attachments.** `POST /api/chat/attachments` (multipart, one file) saves to `<workspace>/uploads/<safe-unique-name>` and returns `{ path }` relative to the workspace. Allow pdf/docx/txt/md only, 10 MB cap, same origin/host protection as the other mutating routes. Add `uploads/` to `.gitignore` and the release manifest's exclusions if needed.
6. **Tests.** Unit tests for each tool against a temporary fixture workspace (never the real home directory), the attachments route, and the chat kind start → reply → reply → abort using the existing fake pi (`ui/server/demoFakePi.mjs` or the test harness the run tests use). Root and UI test suites plus both typechecks must pass.

Slice A doesn't touch `ui/src/`.

## Slice B: frontend (after the mockup is approved)

Filled in after the mockup. Outline: chat is the default route; a composer with drag-and-drop/paste attachments and quick-action chips; message stream with Escape to interrupt; cards rendered from `tool_end.details`; the PJR-26 provider card inline when nothing is connected; forms moved into a drawer; buttons that used to start runs now send a chat message. Build it with the UI design skills and verify with screenshots in light and dark at desktop and phone widths.

## Out of scope

Click-count e2e assertions, a 20-tool surface, per-writer concurrency matrices, review-until-zero loops, history rewrite, platform matrix. They can come later if they matter.
