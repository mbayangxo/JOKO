#!/bin/bash
# J15 L1-L5 multi-seed campaign (LOCAL ONLY): N seeds of a scenario, rotating fault schedules, one fresh copy of a
# template database per seed. Usage: bash scripts/lab/campaign.sh <template-db> <out-dir> <scenario> <ops> <seed0> <n>
set -u
TPL="$1"; OUT="$2"; SCEN="$3"; OPS="$4"; SEED0="$5"; N="$6"; mkdir -p "$OUT"
SCHED=(crash-mix after-commit latency-widen)
for k in $(seq 0 $((N - 1))); do
  seed=$((SEED0 + k)); f=${SCHED[$((k % 3))]}; db="joko_camp_${seed}"
  PGPASSWORD=postgres psql -h localhost -U postgres -q -c "drop database if exists $db" -c "create database $db template $TPL"
  DATABASE_URL="postgres://postgres:postgres@localhost:5432/$db?sslmode=disable" DIRECT_URL="postgres://postgres:postgres@localhost:5432/$db?sslmode=disable" \
    timeout 3600 node scripts/lab/run.mjs --scenario "$SCEN" --seed "$seed" --ops "$OPS" --concurrency 12 --users 60 \
      --faults "scripts/lab/faults/$f.json" --out "$OUT/$SCEN-$seed-$f" > "$OUT/$SCEN-$seed-$f.out" 2>&1
  echo "seed $seed $f exit $? $(grep -o '"verdict": "[A-Z]*"' "$OUT/$SCEN-$seed-$f.out")"
  PGPASSWORD=postgres psql -h localhost -U postgres -q -c "drop database if exists $db"
done
