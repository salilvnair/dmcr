#!/usr/bin/env bash
# Runs the dmcr.sh test suites against a throwaway PostgreSQL 16 container.
# Needs Docker. Usage: bash scripts/runner/tests/run-tests.sh   (or: npm run test:runner)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$(dirname "$HERE")"
NAME="${DMCR_TEST_PG:-dmcr-test-pg}"
export MSYS_NO_PATHCONV=1   # Git Bash on Windows: keep container paths as written

docker rm -f "$NAME" >/dev/null 2>&1
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=dmcrtest -e POSTGRES_DB=dmcrtest \
  -v "$RUNNER:/runner:ro" -v "$HERE:/tests:ro" postgres:16 >/dev/null || exit 1
trap 'docker rm -f "$NAME" >/dev/null 2>&1' EXIT

for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -d dmcrtest -h localhost >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" bash -c 'command -v perl >/dev/null' || { echo "perl missing in container"; exit 1; }
# Node.js for the runner's conflict check (dmcr_conflicts.cjs; without it a deploy is refused): node:20-bookworm's
# binary, copied into /usr/local/bin (postgres:16 is Debian bookworm too)
NODE_SRC="${NAME}-node"
docker rm -f "$NODE_SRC" >/dev/null 2>&1
docker create --name "$NODE_SRC" node:20-bookworm >/dev/null || exit 1
docker cp "$NODE_SRC:/usr/local/bin/node" - | docker cp - "$NAME:/usr/local/bin/" || { docker rm -f "$NODE_SRC" >/dev/null 2>&1; exit 1; }
docker rm -f "$NODE_SRC" >/dev/null 2>&1
docker exec "$NAME" node --version >/dev/null || { echo "node missing in container"; exit 1; }

status=0
for suite in high.sh security.sh rehearsal.sh roundtrip.sh promotion.sh envnames.sh releases.sh zerodowntime.sh review.sh hardening.sh; do
  echo; echo "######## $suite"
  docker exec "$NAME" bash "/tests/$suite" || status=1
done
echo; [[ $status -eq 0 ]] && echo "ALL RUNNER SUITES PASSED" || echo "SOME RUNNER TESTS FAILED"
exit $status
