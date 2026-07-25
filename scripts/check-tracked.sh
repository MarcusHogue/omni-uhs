#!/usr/bin/env bash
#
# Guard against source files that git is silently ignoring.
#
# This exists because it already happened: an unanchored `cache/` in .gitignore
# matched `proxy/src/cache/`, so the build worked on my machine and the
# committed tree did not compile. A working tree that builds proves nothing
# about what was pushed.
#
#   npm run check:tracked
#
# In CI this is a no-op — a clean checkout only contains tracked files — so the
# real backstop there is building from the checkout. This is the local one.

set -euo pipefail
cd "$(dirname "$0")/.."

paths=(web/src web/tools web/test/parser web/test/storage web/test/e2e proxy/src proxy/test)

ignored=$(
  find "${paths[@]}" -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' -o -name '*.json' \) 2>/dev/null |
    git check-ignore --stdin 2>/dev/null || true
)

if [ -n "$ignored" ]; then
  echo "error: these source files are gitignored and will never be committed:" >&2
  echo "$ignored" | sed 's/^/  /' >&2
  echo >&2
  echo "Fix the pattern in .gitignore (anchor it with a leading slash?)." >&2
  exit 1
fi

# The other half of the same problem: a file that exists, is not ignored, and
# was simply never added.
untracked=$(git ls-files --others --exclude-standard -- "${paths[@]}")
if [ -n "$untracked" ]; then
  echo "warning: these source files are not tracked by git:" >&2
  echo "$untracked" | sed 's/^/  /' >&2
  exit 1
fi

echo "all source files are tracked"
