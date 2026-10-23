# T10 design direction

Open [`index.html`](./index.html) in a browser. It is a dependency-free prototype with synthetic data and five clickable surfaces: Today, Discover, Run, Setup, and Settings. The rail is the durable information architecture; the live run card remains visible in the rail while the dedicated Run view owns the transcript and user request.

## Screen map

| Route | Job to be done | Primary action | Important secondary state |
| --- | --- | --- | --- |
| `/` Today | Decide what needs attention now | Open the waiting run or apply the next reviewed job | No queue, setup blocker, recent estimated outcome |
| `/discover` Discover | Inspect, explain, and promote a candidate | Promote selected job to Queue | Gathering, unscored, source unavailable, no matches |
| `/queue` Queue | Confirm the agent's actual next item | Apply next / remove item | Empty queue, duplicate, active run lock |
| `/applications` Applications | Track execution and hiring progress separately | Open a record and update hiring stage | Confirmed receipt, estimated record, missing evidence |
| `/runs/current` Run | Supervise a live browser task | Satisfy the pinned request, finish, or abort | Reconnecting, stopped, failed, interrupted |
| `/setup` Setup | Resolve capability blockers in order | Save the current step and continue | Invalid key, save conflict, optional CAPTCHA skipped |
| `/profile` Profile | Maintain truthful answers, preferences, and resume rules | Save a section or upload/assign a PDF | Missing required field, upload error, custom Markdown |
| `/settings` Settings | Control model connections and local diagnostics | Add/test/select a connection | Key absent, invalid test, next-run activation |

## Visual decisions

- Palette is warm neutral (`#f4f3ef`) with one muted green accent (`#176b52`); amber and red only communicate attention and failure. Dark mode keeps the same hue relationships.
- Georgia is a system-available display fallback with a system sans body. This gives the work a human editorial voice without requiring a font CDN or new dependency. Large type is reserved for page purpose and selected job title.
- The layout uses a sticky compact rail on desktop and a horizontally scrollable top nav on narrow screens. Cards are reserved for workflow boundaries; list rows and separators carry the dense work.
- Job names and companies are the first-class language. Paths, slugs, process IDs, and raw tool output stay out of the primary view.
- Every state includes a next action in its own context. Waiting work is visible in both Today and the persistent run mini-card. Application execution status is explicitly separate from hiring stage.

## Responsive review

The prototype is designed to review at 1440, 1024, 768, and 390 CSS pixels. At 820px the rail becomes a sticky top nav; at 480px the list/detail shell stacks, log timestamps move above entries, and form steps become a horizontal strip. There is no page-wide horizontal overflow at 390px.

## Feature-parity checklist for T11+

- [ ] Today prioritizes setup blockers and waiting work before totals.
- [ ] Discover supports stable selection, filters, score/reason, gather/score, dismiss, and promotion.
- [ ] Queue preserves actual `listQueue` consumption order and uses accurate apply/remove labels.
- [ ] Applications distinguishes process outcome from hiring pipeline stage and receipt evidence.
- [ ] Run preserves one-run locking, request focus, draft reply, SSE recovery, finish versus abort, and manual handoff.
- [ ] Setup exposes five saved steps and capability readiness without false readiness.
- [ ] Profile edits truthful user data and resume assignment with revision/error handling.
- [ ] Settings keeps key values write-only and exposes source, test status, scoring choice, CAPTCHA, accounts, and browser checks.
- [ ] Shared components provide visible focus, reduced motion, non-color status, loading, empty, and recoverable error states.
