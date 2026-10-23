#!/usr/bin/env bash
#
# Scaffold the user-data files a fresh clone needs, from templates/.
# Safe to re-run: every copy is skipped if the destination already exists, so
# this never overwrites a filled-in profile or a live state.json.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

created=0
skipped=0

copy_if_absent() {
  local src="$1" dst="$2"
  if [ -e "$dst" ]; then
    printf '  skip    %s (already exists)\n' "$dst"
    skipped=$((skipped + 1))
  else
    cp "$src" "$dst"
    printf '  create  %s\n' "$dst"
    created=$((created + 1))
  fi
}

echo "Scaffolding workspace in $ROOT"

copy_if_absent templates/profile.template.md profile.md
copy_if_absent templates/targets.template.md targets.md
copy_if_absent templates/state.json state.json
copy_if_absent templates/gather_state.json gather_state.json
copy_if_absent templates/credentials.json credentials.json
copy_if_absent templates/settings.json settings.json

for dir in jobs/queue jobs/applied jobs/discovered resumes screenshots; do
  if [ -d "$dir" ]; then
    printf '  skip    %s/ (already exists)\n' "$dir"
  else
    mkdir -p "$dir"
    printf '  create  %s/\n' "$dir"
  fi
done

chmod 600 credentials.json settings.json 2>/dev/null || true

echo
echo "Created $created file(s), skipped $skipped."
echo
echo "Next:"
echo "  1. Fill in profile.md — every <FILL IN>, plus the resume and city tables."
echo "  2. Put your resume at resumes/default.pdf."
echo "  3. List companies to poll in targets.md."
echo "  4. npm run build && npm start   # optional web UI from repo root"
echo "  5. Run 'pi' from this directory and try /status."
