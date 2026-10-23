# Font source provenance

Rolebound ships self-hosted WOFF2 files. Both families are licensed under the SIL Open Font License 1.1 (see `OFL-funnel.txt`).
The product file names stay generic so CSS consumes `Rolebound Display` and `Rolebound Body` whatever face backs them.

## Display: Funnel Display

| Field | Value |
| --- | --- |
| Product file | `rolebound-display.woff2` |
| Catalog | https://fonts.google.com/specimen/Funnel+Display |
| Upstream project | https://github.com/Dicotype/Funnel |
| Source | `@fontsource-variable/funnel-display@5.3.0`, `files/funnel-display-latin-wght-normal.woff2` |
| License | `OFL-funnel.txt` |
| Build | Latin subset of the variable font; `wght` axis 300 to 800 |

## Body: Funnel Sans

| Field | Value |
| --- | --- |
| Product file | `rolebound-body.woff2` |
| Catalog | https://fonts.google.com/specimen/Funnel+Sans |
| Upstream project | https://github.com/Dicotype/Funnel |
| Source | `@fontsource-variable/funnel-sans@5.3.0`, `files/funnel-sans-latin-wght-normal.woff2` |
| License | `OFL-funnel.txt` |
| Build | Latin subset of the variable font; `wght` axis 300 to 800 |

## CSS contract for shell integration

```css
--font-display: "Rolebound Display", "Funnel Display", ui-sans-serif, system-ui, sans-serif;
--font-body: "Rolebound Body", "Funnel Sans", ui-sans-serif, system-ui, sans-serif;
```

Load `/fonts/rolebound.css` from `ui/index.html` (already wired). Do **not** add Google Fonts CDN links.
