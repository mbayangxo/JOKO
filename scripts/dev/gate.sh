#!/bin/bash
# LOCAL fresh-database engineering gate (J1 → latest). Never touches production.
#   scripts/dev/gate.sh <worktree> <outdir> <dbname> [web-dir] [playwright-core] [chromium]
# The worktree must have its OWN node_modules (not a symlink) at the commit under test.
# Database health is checked before and after every step: if Postgres is down or has restarted
# (postmaster start time changed), the run is VOID — it never reports application failures that
# were really a database outage.
set -u
WT=$1; OUT=$2; DB=$3
WEB=${4:-$OUT/web}; PW=${5:-}; CHROME=${6:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}
mkdir -p "$OUT"; S=$OUT/summary.txt
cd "$WT" || exit 2
export DATABASE_URL="postgres://postgres:postgres@localhost:5432/$DB?sslmode=disable"
export DIRECT_URL="$DATABASE_URL"
ADMIN='postgres://postgres:postgres@localhost:5432/postgres'

bash "$WT/scripts/dev/ensure-postgres.sh" > /dev/null || { echo "VOID database_unavailable_at_start" > "$S"; exit 2; }
START=$(psql "$ADMIN" -tAc 'select pg_postmaster_start_time()')
check_db() {
  if ! pg_isready -q -h localhost -p 5432; then echo "VOID database_down_during $1" >> "$S"; echo DONE_VOID >> "$S"; exit 2; fi
  local now; now=$(psql "$ADMIN" -tAc 'select pg_postmaster_start_time()')
  if [ "$now" != "$START" ]; then echo "VOID database_restarted_during $1" >> "$S"; echo DONE_VOID >> "$S"; exit 2; fi
}
step() { # step <name> <log> <command...>
  local name=$1 log=$2; shift 2
  "$@" > "$OUT/$log" 2>&1; local rc=$?
  check_db "$name"
  echo "$name $rc" >> "$S"
}
inv() { node -e "import('./lib/$1').then(async m=>{const r=await m.$2();console.log(JSON.stringify(r));process.exit(r.ok?0:1)})"; }

psql "$ADMIN" -q -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB"
echo "commit $(git rev-parse --short HEAD)" > "$S"
echo "postgres_started $START" >> "$S"
[ -L node_modules ] && { echo "node_modules_isolated NO (symlink)" >> "$S"; exit 1; }
cmp -s node_modules/.prisma/client/schema.prisma prisma/schema.prisma; echo "client_matches_schema $?" >> "$S"
step setup setup.log npm run test:db:setup
step test test.log npm test
step money_after_suite money1.log npm run money:check
step logistics_after_suite logistics1.log inv logistics/invariants.js checkLogisticsInvariants
step work_after_suite work1.log inv work/invariants.js checkWorkInvariants
step collective_after_suite collective1.log inv collective/invariants.js checkCollectiveInvariants
step load load.log npm run test:load
step sweep sweep.log npm run test:sweep
step money_after_all money2.log npm run money:check
step logistics_after_all logistics2.log inv logistics/invariants.js checkLogisticsInvariants
step work_after_all work2.log inv work/invariants.js checkWorkInvariants
step collective_after_all collective2.log inv collective/invariants.js checkCollectiveInvariants
rm -rf "$WEB"
step web web.log env EXPO_NO_TELEMETRY=1 npx expo export --platform web --output-dir "$WEB"
for e in j8 j9 j10 j11 $(ls tests/e2e/ | sed -n 's/^\(j1[2-9]\)-ui\.mjs$/\1/p'); do
  step "e2e_$e" "e2e-$e.log" env WEB_DIR="$WEB" PLAYWRIGHT_CORE="$PW" CHROMIUM="$CHROME" node "tests/e2e/$e-ui.mjs"
done
step rehearsal rehearsal.log env REHEARSAL_ADMIN_URL="$ADMIN" node scripts/rehearse-migration.mjs
psql "$ADMIN" -q -c "DROP DATABASE IF EXISTS ${DB}_shadow" -c "CREATE DATABASE ${DB}_shadow"
npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma \
  --shadow-database-url "postgres://postgres:postgres@localhost:5432/${DB}_shadow?sslmode=disable" --script > "$OUT/schemadiff.sql" 2>&1
grep -v '^$' "$OUT/schemadiff.sql" | grep -qv -- '-- This is an empty migration.' && echo "schema_diff NONEMPTY" >> "$S" || echo "schema_diff empty" >> "$S"
check_db schema_diff
step audit_critical audit.log npm audit --omit=dev --audit-level=critical
# Deploy-inert: no new cron in vercel.json, and every J11+ money switch defaults OFF in code.
crons=$(node -e "const v=require('./vercel.json');console.log((v.crons||[]).map(c=>c.path).join(','))")
echo "vercel_crons $crons" >> "$S"
echo "$crons" | grep -qE 'collective|protected|affiliate' && echo "deploy_inert NO (new money cron scheduled)" >> "$S" || echo "deploy_inert yes" >> "$S"
cmp -s node_modules/.prisma/client/schema.prisma prisma/schema.prisma; echo "client_still_matches_schema $?" >> "$S"
check_db end
echo DONE >> "$S"
