#!/usr/bin/env bash
# Runs the dmcr.sh test suites against a throwaway PostgreSQL 16 container.
# Needs Docker. Usage: bash scripts/runner/tests/run-tests.sh   (or: npm run test:runner)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$(dirname "$HERE")"
NAME=dmcr-test-pg
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

status=0
for suite in high.sh security.sh rehearsal.sh; do
  echo; echo "######## $suite"
  docker exec "$NAME" bash "/tests/$suite" || status=1
done
echo; [[ $status -eq 0 ]] && echo "ALL RUNNER SUITES PASSED" || echo "SOME RUNNER TESTS FAILED"
exit $status
