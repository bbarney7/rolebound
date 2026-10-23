# Third-party notices

Rolebound's own source code is licensed under the MIT License (see [LICENSE](LICENSE)).
The files and packages below keep their own licenses.

## Bundled in this repository

| What | Where | License |
| --- | --- | --- |
| Funnel Display and Funnel Sans fonts (Latin subsets, shipped as `rolebound-display.woff2` and `rolebound-body.woff2`) | `ui/public/fonts/` | SIL Open Font License 1.1, full text in [`ui/public/fonts/OFL-funnel.txt`](ui/public/fonts/OFL-funnel.txt). Copyright 2023 The Funnel Project Authors. Provenance in [`ui/public/fonts/SOURCES.md`](ui/public/fonts/SOURCES.md). |
| Provider marks from Simple Icons | `ui/public/brand/providers/` | CC0 1.0, see the `LICENSE-simple-icons-*.md` files there. The marks themselves remain trademarks of their owners; showing them does not imply endorsement. |

## Installed from npm

`npm ci` installs dependencies under their own licenses; each package's license file is in
`node_modules/<package>/`. One deserves a specific note:

- **`@cursor/sdk`** (pulled in for the optional Cursor provider through `pi-cursor-sdk`) is
  proprietary software from Anysphere, Inc., not open source. It is installed from npm, not
  redistributed in this repository. Its terms are in `node_modules/@cursor/sdk/LICENSE.md`.
