# Rolebound UI critique — 2026-10-23

Review of `main` at the first public release, using the installed design skills:
`impeccable` (principles and anti-patterns), `critique` (two independent assessments),
`audit` (technical scoring) and `redesign-existing-projects` (existing-UI checklist).

## How it was done

- **Visual review (Claude).** Ran `npm run demo` and captured 76 full-resolution screenshots of
  every surface: chat home, chat with job cards, all seven profile tabs, Found jobs, Shortlist,
  Companies to watch, Applications, Agent instructions, Settings, Site logins, Setup and Today.
  Each at 1440×900 light, 1440×900 dark and 390×844 light. Measured touch targets and button
  contrast in the running page.
- **Independent source review (Codex, GPT Sol, read-only).** Given only the product description
  and the critique checklist, not these findings.
- **Deterministic scan.** `npx impeccable --json ui/src` (67 TSX files).

Fictional demo data only. The demo has no applications, so populated Applications views were
not seen.

**Design context is stale.** `.impeccable.md` still describes the September graphite/citron
horizontal-workspace design that chat-first replaced. Users and voice (job seekers;
decisive, candid, optimistic) still apply and were used here; refresh the visual direction
with `/impeccable teach` before the next design pass.

## Scores

| Measure | Score | Note |
|---|---|---|
| Nielsen heuristics (combined) | **22/40** | Codex independently scored 22/40; the Oct 14 critique scored 23/40 before the refinements |
| Technical audit | **14/20** (Good) | Accessibility 3, Performance 3, Responsive 2, Theming 3, Anti-patterns 3 |
| Cognitive-load checklist | **5 of 8 fail** (high) | Single focus, chunking, one decision at a time, minimal choices, working memory |
| Deterministic scan | 3 warnings | All "side-stripe border": `config.css:122`, `index.css:939`, `surfaces.css:625` |

The Oct 15 refinements fixed what they targeted (composer focus, settings order, drawer focus
trap, markdown, save feedback). The score barely moved because the remaining problems sit in
surfaces that pass was not about: the job-search pages, resumes, the shortlist, and phone layouts.

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of status | 2 | "Your search" rail (incl. **Needs you**) is `display:none` below 1100px; Gather/Score/Promote go disabled during a chat session with no reason shown |
| 2 | Match to the real world | 2 | `source:slug`, "Reachability", "Files in resumes/", "frontmatter", "mtime", `auto-submit-v1` |
| 3 | User control | 2 | Removing a saved CAPTCHA key and "Discard my changes and reload from disk" are one click, no confirm or undo |
| 4 | Consistency | 2 | One pipeline, eight names (see issue 2); Profile tabs and Job-search tabs are styled differently |
| 5 | Error prevention | 2 | Template placeholder text sits in the Fallback email field as its *value* |
| 6 | Recognition over recall | 2 | Applications empty state says to go type "Apply to the next one" instead of offering the action; companies require ATS slugs from memory |
| 7 | Flexibility | 3 | Enter/Esc, prompt chips, Previous/Next; no filter reset |
| 8 | Aesthetic / minimalist | 2 | Resumes tab and Shortlist footnotes; duplicated headings ("Applications / 0 applications" then "Applications / 0 of 0") |
| 9 | Error recovery | 3 | Drafts survive failures; some raw messages ("API server running on 127.0.0.1:4747?") |
| 10 | Help | 2 | Help is scattered across footnotes and disclosures |

## Anti-pattern verdict

**Not AI slop, but the drawer reads as a developer admin tool.** The chat home is the strongest
surface: Funnel Display/Sans, one restrained blue accent, the folded-R mark, and the stepper rail
give it identity, with no gradient text, glow, glassmorphism or hero metrics. The tells that remain:
three side-stripe banners, a single "white surface, 1px border, 10–16px radius" recipe applied to
nearly everything (Codex counted it across list panels, forms, queue, connections and all five
chat card types), and pills/stamps for every status. Inside the Workspace drawer the product voice
disappears into storage vocabulary.

## What's working

- **Chat home and job cards.** One clear headline, four useful quick actions, and job cards with
  title, company, fit % and an Apply action. This is the product at its best.
- **Agent instructions page.** Three plain-English text areas with one-line explanations. It is
  the model the other drawer pages should follow.
- **Accessibility foundation.** Global `:focus-visible`, reduced motion, labelled controls, live
  regions, drawer focus loop and restoration; Playwright axe checks pass with no serious or
  critical violations. Dark mode is consistent, and the dark primary button measures 7.8:1.

## Priority issues

### 1. [P1] Storage internals leak into the job seeker's screens
- **What:** Resumes tab shows "Resume path override" with literal `**Resume path:**` and `## Resume`
  Markdown, "Files in resumes/", a "Reachability" column, "45 B", and a "Region rules" table of
  keys and expected file paths. Shortlist footnotes explain "file change time", "queue file
  frontmatter" and "filename sort order". Companies to watch is a textarea of `greenhouse:acme`
  lines. Settings shows the policy id `auto-submit-v1`. The template placeholder
  `*(optional — used only when an ATS signup form rejects `+aliasing`)*` appears as the Fallback
  email field's value (`templates/profile.template.md:15`).
- **Why:** A job seeker has to learn how Rolebound stores files before they can trust it. This is
  the biggest gap between the chat's voice and the drawer.
- **Fix:** Resumes becomes "Your resumes": a list of files with Upload, "Default", and "Use for
  jobs in…" chips per file; move overrides and region rules into an Advanced disclosure. Companies
  accepts a company name or careers-page URL and resolves the board, with `source:slug` behind
  Advanced. Move the Shortlist and Applications footnotes into an "About these dates" disclosure.
  Treat template placeholders as empty fields with that text as the input's hint.
- **Commands:** `/clarify`, `/distill`.

### 2. [P1] One pipeline, eight names
- **What:** Drawer "Job search"; tabs "Found jobs / Shortlist / Companies to watch"; page title
  "Opportunities"; copy "promote into preparation"; link "Preparation →"; table "Preparation queue";
  Today's "Opportunities / Preparation / Follow-up"; rail "Found / Shortlisted / Applying / Needs
  you / Sent"; and "Edit targets" for the same thing as "Companies to watch".
- **Why:** Users can't build a stable map, and the old September stage names survive on Discover,
  Shortlist and Today.
- **Fix:** Adopt the rail's words everywhere: Found → Shortlist → Applying → Needs you → Sent, plus
  "Companies to watch". Rename "Promote to queue" to "Add to shortlist", drop "Preparation", rename
  "Edit targets" to "Companies to watch". Also "1 roles to review" (`App.tsx:971`).
- **Commands:** `/clarify`.

### 3. [P1] Supervision status vanishes on laptops and phones
- **What:** `.rb-chat-rail` is `display:none` below 1100px (`chat/shell.css:153`, `:161`), so a
  1024px laptop, a tablet or a phone loses Applying, **Needs you** and Sent. On phones the header
  shrinks the model status to an unlabeled green dot. Gather/Score/Promote disable during a chat
  session with no reason shown.
- **Why:** This is a supervised agent. "Needs you" is the one number that must never disappear.
- **Fix:** Below 1100px, show a compact status line above the composer ("1 needs you · 2 applying")
  that opens the full rail as a sheet. Give disabled run actions an inline reason ("Finish or end
  the chat session to gather").
- **Commands:** `/adapt`, `/clarify`.

### 4. [P1] Phone layouts break on tables and the composer crowds the chat
- **What:** At 390px the Shortlist table wraps "Queued Demo Role" and the URL one letter per line,
  and Resumes wraps "default.pdf" as "de/fault./pdf" with columns clipped. After a conversation
  starts, four prompt chips plus the model chip plus the composer take about a third of the screen.
  Prompt chips are 36px tall and "View posting" links 22px, below the 44px touch target.
- **Fix:** Below about 600px of container width, render Shortlist, Resumes and Applications rows as
  stacked list items (container queries, not viewport). Collapse quick actions into one "Suggestions"
  control once the transcript has messages. Raise chips to 44px and pad the links' hit area.
- **Commands:** `/adapt`, `/layout`.

### 5. [P1] Accessibility defects
- **What:** Chat Markdown links turn `--accent-ink` on hover (`chat/chat.css:119`), which is white
  in light mode and near-black in dark mode, so the link vanishes against the transcript in both.
  The chat model popover declares `role="dialog" aria-modal="true"` without moving or trapping focus
  (`chat/ModelMenu.tsx:160`). The Job-search tabs (`App.tsx:1235`) have no `aria-current` or visual
  active state, and they sit flush against the drawer header with no top spacing.
- **Fix:** Hover with underline thickness or `--accent-strong`, not `--accent-ink`. Make the popover
  a non-modal listbox, or give it full dialog behaviour. Add `aria-current="page"` and the Profile
  tabs' active style to the Job-search tabs, with the same top inset as other drawer pages.
- **Commands:** `/audit`, `/polish`.

## Persona red flags

- **Jordan (first-time job seeker):** Opens Profile → Resumes and meets Markdown syntax and a
  "Region rules" table; sees a placeholder sentence typed into Fallback email and doesn't know
  whether to delete it; is asked for `greenhouse:acme` lines with no way to find a slug.
- **Casey (phone):** Opens the chat after a search and gets three rows of chips above the
  composer; opens Shortlist and gets a table with letters stacked vertically; never sees "Needs you".
- **Sam (keyboard and screen reader):** Hovering a chat link hides it; the model popover announces
  itself as a modal but focus stays behind it; the Job-search tabs don't say which page is current.

## Minor observations

- Applications on an empty workspace shows five filters and a duplicated heading for zero rows; the
  empty state should be a "Find jobs" / "Apply to the next one" button pair.
- `/today` is reachable but missing from the drawer nav and still uses the old stage names; fold it
  into the rail sheet or remove it.
- Job descriptions render in monospace on Found jobs; use the body face.
- The "Same as applying (demo-model)" chat-model chip looks like a fifth quick action; label it as a
  model ("Model: demo-model").
- One-click removal of a saved CAPTCHA key (`SettingsPanel.tsx:268`) and the profile "Discard my
  changes and reload from disk" action (`ProfileView.tsx:579`) have no confirm or undo.
- `.rb-provider-mark` keeps a light tile in dark mode (`providerSetup.css:219`); z-index uses six
  magic numbers with two popups at 80; the UI bundle is a single 609 KB chunk.
- Three side-stripe banners (scan findings above); restyle as full-border or tinted blocks.

Codex also suggested renaming "Apply" to "Start application" with consequence copy beside it. That
was left out on purpose: you asked for no additional warnings or gates in Rolebound.

## Recommended order

1. `/clarify`: one pipeline vocabulary (issue 2) and plain-language copy for Resumes, Shortlist,
   Companies and Settings internals (issue 1).
2. `/distill`: rebuild Resumes as "Your resumes" and Companies as name/URL input with Advanced
   disclosures; empty placeholders (issue 1).
3. `/adapt`: status line below 1100px, phone list layouts, collapsing chips (issues 3–4).
4. `/audit` fixes: link hover, popover focus, tab active state (issue 5).
5. `/polish`: minor observations, side-stripe banners, monospace description.
6. Re-run the critique; refresh `.impeccable.md` with `/impeccable teach` first.
