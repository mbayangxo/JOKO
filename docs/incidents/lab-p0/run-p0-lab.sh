#!/bin/bash
# J15 decision 7: run p0-lab.test.js on 7d262de as deployed (legacy) and on 7d262de + the three emergency
# patches (patched). LOCAL ONLY: each worktree gets its own disposable database. No production access.
#   bash docs/incidents/lab-p0/run-p0-lab.sh <legacy-worktree> <patched-worktree> <out-dir>
# Worktrees: git worktree add --detach <dir> 7d262de; the patched one additionally gets
#   git apply docs/incidents/2026-10-p0-tontine-drain-live/tontine-containment-on-7d262de.patch \
#             docs/incidents/2026-10-p0-delivery-dispute/emergency-7d262de.patch \
#             docs/incidents/2026-10-f1-coop-double-payout/f1-hotfix-on-7d262de.patch
#   and both: node_modules (7d262de lockfile), prisma db push to joko_p0lab_<mode>.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
LEGACY="$1"; PATCHED="$2"; OUT="$3"; mkdir -p "$OUT"
for MODE in legacy patched; do
  WT=$([ "$MODE" = legacy ] && echo "$LEGACY" || echo "$PATCHED")
  mkdir -p "$WT/tests/repro" && cp "$HERE/p0-lab.test.js" "$WT/tests/repro/p0-lab.test.js"
  DB="postgres://postgres:postgres@localhost:5432/joko_p0lab_${MODE}?sslmode=disable"
  ( cd "$WT" && P0_LAB_MODE=$MODE DATABASE_URL="$DB" DIRECT_URL="$DB" timeout 900 node --test --test-concurrency=1 tests/repro/p0-lab.test.js ) > "$OUT/$MODE.log" 2>&1
  echo "$MODE exit $? $(git -C "$WT" log --oneline -1 | cut -c1-8) patched_files=$(git -C "$WT" diff --name-only | tr '\n' ' ')"
  grep -E "^# (pass|fail)|^not ok" "$OUT/$MODE.log"
  grep -o 'LAB_RESULT .*' "$OUT/$MODE.log" | sed 's/^LAB_RESULT //'
done
