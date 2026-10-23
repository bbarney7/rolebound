# Rolebound brand guidance

**Rolebound** is the working product name for the redesigned local job-search workspace. It is used in UI copy, documentation, and marketing drafts only. **No claim is made** that the name, domain, or mark is legally cleared, registered, or available for exclusive use.

## Voice

Decisive, candid, optimistic. The product should feel like a capable personal workspace with forward momentum and visible control — not a generic dashboard or automation gimmick.

## Mark

Original folded-path **R** expressing a next step. Citron fold planes suggest forward movement. The silhouette must remain identifiable at **16px** and in **monochrome**.

| Asset | Path | Use |
| --- | --- | --- |
| Primary mark | `/brand/rolebound-mark.svg` | Header, inline brand |
| Monochrome mark | `/brand/rolebound-mark-mono.svg` | Single-ink contexts |
| On dark | `/brand/rolebound-mark-on-dark.svg` | Dark chrome / inverse panels |
| Favicon | `/brand/rolebound-favicon.svg` | Browser tab (`ui/index.html`) |
| App icon | `/brand/rolebound-icon.svg` | Install / OS icon contexts |
| App icon mono | `/brand/rolebound-icon-mono.svg` | Print / single-color |
| Wordmark | `/brand/rolebound-wordmark.svg` | Horizontal lockup (outlined paths; no embedded font dependency) |

Preview all variants: `/brand/board.html` (local dev server).

### Do not use

- π / pi glyph, robots, briefcases, rockets, sparkles, or other generic “job app” clipart
- Previous forest-green / Georgia visual system
- Google Fonts CDN at runtime

## Color

| Token | Hex | Role |
| --- | --- | --- |
| Graphite | `#232830` | Primary ink, frames |
| Graphite 2 | `#3A4150` | Secondary ink |
| Citron | `#C9D936` | Brand accent, fold highlights |
| Citron ink | `#2A3008` | Text on citron |
| Canvas | `#F3F5F8` | Page ground (light) |
| Surface | `#FFFFFF` | Panels (light) |

Dark theme surfaces are owned by the shell CSS agent; marks provide `rolebound-mark-on-dark.svg` and light marks on graphite app icons.

## Typography

| Role | Family | File |
| --- | --- | --- |
| Display | Rolebound Display (Funnel Display) | `/fonts/rolebound-display.woff2` |
| Body | Rolebound Body (Funnel Sans) | `/fonts/rolebound-body.woff2` |

CSS entry: `/fonts/rolebound.css` (loaded from `ui/index.html`).

License: `ui/public/fonts/OFL-funnel.txt`. Provenance: `ui/public/fonts/SOURCES.md`.

Use minimal variable weights (200–800 display, 100–900 body). Rejected: Inter, Space Grotesk, Instrument Sans, Manrope.

## Workspace navigation (user-visible)

Stage links on `nav[aria-label="Workspace stages"]` — visible text matches accessible name:

| Route | Label |
| --- | --- |
| `/` | Today |
| `/discover` | Opportunities |
| `/queue` | Preparation |
| `/applications` | Follow-up |

Header session control: **Agent session:** `Idle` / `Resume` / `Live` (compact on mobile; no Run nav link).

## Integration notes for other lanes

- Shell sets `--font-display` / `--font-body` via `rolebound.css` and `/brand/rolebound-mark.svg` in the product header.
- Mobile collapsed header (`.rail-top` top → `.nav` bottom, More panel closed): measured **~97px** at 320–768px; E2E ceiling **158px** (`assertCollapsedMobileHeader`).
- Accessibility: root verified **18** route/theme surfaces (9 routes × light/dark) with **zero unfiltered axe violations** (`/tmp/rolebound-redesign/axe-final.json`). Playwright axe checks in `journey.spec.ts` / `visual-gate.spec.ts` use full rules (serious/critical threshold unchanged).
- E2E in release manifest: `brand.spec.ts`, `journey.spec.ts`, `visual-gate.spec.ts`, `discovery-race.spec.ts` (primary-owned race regression), `test-helpers.ts`.
- `brand.spec.ts` asserts: document title **Rolebound**, favicon at `/brand/rolebound-favicon.svg`, self-hosted WOFF2 with `FontFaceSet` `loaded` + computed fonts, no remote font CDN requests, wordmark SVG without `<text>` dependencies.

## Internal compatibility

Runtime paths, npm package names, and pi slash commands remain **`pi-jobs`** / existing workspace paths. User-visible browser title in `ui/index.html` is **Rolebound**.
