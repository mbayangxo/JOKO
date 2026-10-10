#!/bin/bash
# LOCAL development / test only — never used by production.
# Root cause (docs/JOKKO-LOCAL-POSTGRES.md): the cloud dev container is a Firecracker VM whose PID 1 is not an
# init system. When the VM is paused/reclaimed and restored, Postgres is killed without a clean shutdown and
# nothing restarts it. This script starts it (crash recovery runs automatically) and waits until it accepts
# connections, or fails loudly.
set -u
HOST=${PGHOST:-localhost}
PORT=${PGPORT:-5432}
if pg_isready -q -h "$HOST" -p "$PORT"; then
  echo "postgres: ready ($HOST:$PORT)"
  exit 0
fi
if command -v service >/dev/null 2>&1; then
  service postgresql start >/dev/null 2>&1 || true
fi
for _ in $(seq 1 60); do
  if pg_isready -q -h "$HOST" -p "$PORT"; then
    echo "postgres: started ($HOST:$PORT)"
    exit 0
  fi
  sleep 1
done
echo "postgres: UNAVAILABLE at $HOST:$PORT after 60 s — tests and the gate must not run" >&2
exit 1
