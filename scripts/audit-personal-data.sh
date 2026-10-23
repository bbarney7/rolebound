#!/usr/bin/env bash
#
# Pre-publish audit: fail if anything personal is in the working tree or in ANY
# commit in history. Run it before pushing this repo — or a fork of it — anywhere
# public. Exit 0 = clean, exit 1 = findings.
#
#   ./scripts/audit-personal-data.sh            # tree + full history
#   ./scripts/audit-personal-data.sh --tree     # working tree only (faster)
#
# The patterns here are deliberately generic — this script ships publicly, so it
# must not itself contain anyone's name, address, or email. To check for your own
# specific strings, create `.audit-denylist` in the repo root: one extended-regex
# per line, `#` for comments. That file is gitignored.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TREE_ONLY=0
[ "${1:-}" = "--tree" ] && TREE_ONLY=1

findings=0

# Matches that are expected and fine: documentation placeholders, reserved
# example domains (RFC 2606), the ATS sender addresses the agent looks for, and
# CAP-abcdefgh, the placeholder CapSolver key used by the plan and test fixtures.
ALLOW='example\.(com|org|net)|@ats\.example|no-reply@us\.greenhouse-mail\.io|<FILL IN>|<local>|<your-email-local>|user\+company|applicant\+|jane-doe|@domain|<sender>|<company>|<host>|audit-personal-data\.sh|CAP-abcdefgh'

# Files that are the user's data and must never be tracked.
FORBIDDEN_PATHS='^(profile\.md|state\.json|gather_state\.json|credentials\.json|settings\.json|targets\.md|APPLIED\.md|capsolver\.json)$|^jobs/.*\.md$|^resumes/.*\.pdf$|^screenshots/.*\.(png|jpg|jpeg)$|^\.browser-data'

report() { # <label> <matches>
  local label="$1" matches="$2"
  if [ -n "$matches" ]; then
    findings=$((findings + 1))
    printf '\n✗ %s\n' "$label"
    printf '%s\n' "$matches" | sed 's/^/    /' | head -30
  else
    printf '✓ %s\n' "$label"
  fi
}

# `-e` everywhere: several patterns start with "--", which grep and git grep
# would otherwise parse as options — and because both calls end in `|| true`,
# that failure would look like a passing check.
#
# This file is excluded from both scans: it necessarily contains every pattern
# it searches for, and the history scan has no path to allowlist against.
SELF='scripts/audit-personal-data.sh'

scan_tree() { # <regex> -> matching "path:line:text", allowlist applied
  git grep -nIE -e "$1" -- . ":(exclude)$SELF" 2>/dev/null | grep -vE -e "$ALLOW" || true
}

scan_history() { # <regex> -> matching added lines across all commits
  git log -p --all --no-color -G"$1" -- . ":(exclude)$SELF" 2>/dev/null \
    | grep -E -e "^\+" | grep -E -e "$1" | grep -vE -e "$ALLOW" | sort -u || true
}

echo "Auditing $ROOT"
echo

# ── 1. Tracked user-data files ──────────────────────────────────────────────
report "no user-data files tracked" "$(git ls-files | grep -E "$FORBIDDEN_PATHS" || true)"

if [ "$TREE_ONLY" -eq 0 ]; then
  report "no user-data file ever committed" \
    "$(git log --all --pretty=format: --name-only --diff-filter=A 2>/dev/null | sort -u | grep -E "$FORBIDDEN_PATHS" || true)"
fi

# ── 2. Generic personal-data patterns ───────────────────────────────────────
# TLD list rather than `[A-Za-z]{2,}`: dotted config identifiers such as
# `pkg@scope.someKey.headless` otherwise match the generic form on every run,
# and an audit everyone learns to ignore is worse than a narrower one. Add your
# TLD here if it is missing.
TLD='com|org|net|edu|gov|mil|int|io|dev|app|ai|co|me|us|uk|ca|de|fr|jp|au|nl|se|no|fi|dk|es|it|ch|at|be|ie|pl|pt|cz|in|br|mx|nz|ru|cn|fm|xyz|tech|email|pro|name|live|cloud|online|site|so|to|sh|gg|ly|is'

declare -a CHECKS=(
  "email addresses|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.($TLD)\b"
  "absolute home paths|/(Users|home)/[A-Za-z0-9._-]+/"
  "US phone numbers|\b[0-9]{3}-[0-9]{3}-[0-9]{4}\b"
  "street addresses|\b[0-9]{2,5} [A-Z][A-Za-z]+ (St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive|Way|Ct|Court)\b"
  "CapSolver API keys|CAP-[A-Za-z0-9]{8}"
  "cloud project ids|--project=[a-z0-9-]+"
  "linkedin profiles|linkedin\.com/in/[A-Za-z0-9-]+"
)

for check in "${CHECKS[@]}"; do
  label="${check%%|*}"
  pattern="${check#*|}"
  report "tree: no $label" "$(scan_tree "$pattern")"
  if [ "$TREE_ONLY" -eq 0 ]; then
    report "history: no $label" "$(scan_history "$pattern")"
  fi
done

# ── 3. Your own deny-list ───────────────────────────────────────────────────
if [ -f .audit-denylist ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    report "tree: no match for local deny-list entry" \
      "$(git grep -nIE -e "$line" -- . ":(exclude)$SELF" ":(exclude).audit-denylist" 2>/dev/null || true)"
    if [ "$TREE_ONLY" -eq 0 ]; then
      report "history: no match for local deny-list entry" \
        "$(git log -p --all --no-color -G"$line" -- . ":(exclude)$SELF" 2>/dev/null \
          | grep -E -e "^\+" | grep -E -e "$line" | sort -u || true)"
    fi
  done < .audit-denylist
else
  echo "· no .audit-denylist file — skipping personal-string checks"
fi

echo
if [ "$findings" -eq 0 ]; then
  echo "PASS — nothing personal found."
  exit 0
fi
echo "FAIL — $findings check(s) found something. Nothing should be pushed until these are resolved."
exit 1
