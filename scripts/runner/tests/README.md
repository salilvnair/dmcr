# Runner tests

End-to-end tests for `dmcr.sh` and `dmcr.ps1` against a throwaway PostgreSQL 16 container. They need Docker and create and remove a container named `dmcr-test-pg`.

| Command | What runs |
|---|---|
| `npm run test:runner` | `high.sh`, `security.sh`, `rehearsal.sh` and `roundtrip.sh` inside the container (Bash runner) |
| `npm run test:runner:ps` | `high.ps1`, `security.ps1`, `rehearsal.ps1` and `roundtrip.ps1` under Windows PowerShell 5.1; psql runs in the container through `psql-shim.ps1` |

What the suites cover:

- **high**
  - verify runs inside the deploy, revert and repeatable transactions, and a failing verify rolls everything back;
  - `COMMIT` and psql meta-commands are blocked;
  - `requires` order (plus cycle detection in the PowerShell suite);
  - `--to` validation;
  - `revert to @tag` keeps the tagged change;
  - danger rules;
  - the deploy lock is always released.
- **security**
  - against a password-protected role, the password reaches psql only through `PGPASSWORD`, never on its command line;
  - covers URL (percent-encoded) and `key=value` connection strings;
  - a wrong password is rejected.

- **rehearsal**, a production-style run on 200k customers and 500k orders:
  - a release with a dependency chain and a failing change in the middle (good changes stay applied, the failed one leaves nothing);
  - an application lock on a table (deploy gives up after `lock_timeout` instead of hanging);
  - two deploys racing (exactly one runs);
  - an applied `deploy.sql` edited after release (`check` reports it, deploy refuses with `checksum_policy = block`);
  - `revert to @tag` and roll forward on real data;
  - repeatables;
  - `CREATE INDEX CONCURRENTLY` with `"transaction": false`, including a failing one;
  - `status --json` stays a JSON array for 0 and 1 changes.

- **roundtrip** — `dmcr test`: a correct change passes and leaves nothing behind; a revert that loses data, leaves an index behind or fails, and a verify that fails, are each caught and named; `--json`, `--to`, stopping at changes that can't be rolled back, refusing `prod` without `--allow-prod`, skipping applied changes.

The extension end-to-end suite (`npm run test:e2e`, in `src/test/e2e`) reuses `psql-shim.ps1` / `psql-shim.sh`.

Each suite prints `RESULT: N passed, M failed` and exits non-zero on any failure.
