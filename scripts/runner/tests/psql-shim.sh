#!/usr/bin/env bash
# Test-only psql stand-in (macOS/Linux): forwards to psql inside the dmcr-test-pg container.
# Files passed with -f are copied into the container first; PGPASSWORD is passed through.
args=()
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-f" && $# -ge 2 ]]; then
    remote="/tmp/shim_$$_$RANDOM.sql"
    docker cp "$2" "dmcr-test-pg:$remote" >/dev/null
    args+=("-f" "$remote"); shift 2
  else
    args+=("$1"); shift
  fi
done
if [[ -n "${PGPASSWORD:-}" ]]; then exec docker exec -i -e PGPASSWORD dmcr-test-pg psql "${args[@]}"; fi
exec docker exec -i dmcr-test-pg psql "${args[@]}"
