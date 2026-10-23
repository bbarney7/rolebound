# Rolebound — product redesign

The owner explicitly rejected the previous UI and authorized a complete redesign and new name/icon. Existing page composition, palette, typography, navigation and component markup are not constraints. Keep the verified local runtime, BYOK, applicant data and supervised execution behavior.

## Design context
Audience: people running their own job-search assistant locally, supplied by the owner in the original brief. They prepare their profile, discover/select roles, supervise agent applications and track responses. The owner grants full creative direction. Chosen personality: decisive, candid, optimistic. Desired feeling: a capable personal workspace with forward momentum and visible control.

Working name: **Rolebound**. No claim of exclusive name/domain/trademark availability. Custom vector mark: an original folded path/letter R expressing a next step, identifiable at16px and monochrome. No pi glyph, robot, briefcase, rocket or generic sparkles.

## New visual direction
Graphite ink/frame, citron brand accent, cool pale work surfaces. Default light for daytime job-search work; designed dark mode. Sans typography: Bricolage Grotesque display, Hanken Grotesk body; self-hosted OFL assets. Reflex fonts Inter, Space Grotesk and Instrument Sans rejected. Font catalog references: https://fonts.google.com/specimen/Bricolage+Grotesque and https://fonts.google.com/specimen/Hanken+Grotesk. No inherited Georgia/forest-green/cream system.

Replace the left sidebar with a compact horizontal product header, navigation around work stages, and a persistent agent-session affordance. Main overview should guide the next useful action, not summarize dashboard metrics. Opportunities is a deliberate triage workspace with list/detail and preparation queue access. Applications is a clear follow-up workspace. Profile/settings/onboarding are focused work surfaces reached through accessible workspace navigation. Run is an observable supervised session. Existing route URLs may remain compatible, but display labels, hierarchy and layout may change. Every existing capability must stay reachable.

## Implementation tickets and ownership
1. Brand assets: original SVG mark/icon variants, favicon, wordmark treatment, local font assets+licenses, brand guidance. Asset agent owns ui/public/brand, ui/public/fonts, ui/index.html, docs/brand.md and release manifest asset boundary.
2. Shell and primary workspace: replace AppShell/AppNavigation/Topbar, Today/Discover, App composition and index.css; primary agent owns those files. Rebuild CSS, do not append a cosmetic theme patch.
3. Work surfaces: rebuild Setup/Profile/Connections/CAPTCHA/Queue/Applications/Run/Accounts markup and interactions presentation; surfaces agent owns their page components and a separate surfaces.css. Preserve contracts and concurrency/error handling.
4. Integration: coordinator reviews actual renderings and behavior; agents correct concrete findings. Update browser tests to new intentional navigation without weakening assertions. Add brand/icon, all-route, keyboard, responsive and offline font verification.
5. Release: update user-facing brand docs/metadata while retaining internal compatibility names/paths. Re-run tests/types/build, real runtime/demo/server smokes, release audit and clean-export verification. Assemble updated source candidate only after review.

## Shared contracts
Primary owns global tokens/base CSS. Tokens: --canvas, --surface, --surface-2, --ink, --muted, --line, --accent, --accent-ink, --danger, --success, --font-display, --font-body. Preserve aliases needed by existing code until all surfaces migrate. All agents cooperate through /tmp/rolebound-redesign/*.md, never overwrite each other's files. Asset paths: /brand/rolebound-mark.svg, /brand/rolebound-icon.svg; fonts /fonts/rolebound-display.woff2 and /fonts/rolebound-body.woff2.

## Acceptance
The result must be recognizably different in information hierarchy and page structure, not a recolor. Original icon works small, monochrome and light/dark. No fake functionality or fabricated user data. Real first-use onboarding, BYOK, target management, resume selection, fake supervised application/receipt/stage and all existing route capabilities work. Accessible navigation/actions at390/768/1024/1440; meaningful dark layouts and reduced motion. Source remains clean of credentials and runtime data. Existing original checkout and previous release candidate remain untouched until a new candidate is verified. License/public GitHub destination remain pending.

All product implementation uses Cursor CLI composer-2.5, never fast mode. Coordinator plans, reviews, verifies and handles Git.
