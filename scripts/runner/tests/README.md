# Runner tests

End-to-end tests for `dmcr.sh` and `dmcr.ps1` against a throwaway PostgreSQL 16 container. They need Docker and create and remove a container named `dmcr-test-pg`.

| Command | What runs |
|---|---|
| `npm run test:runner` | `high.sh`, `security.sh`, `rehearsal.sh`, `roundtrip.sh`, `promotion.sh`, `releases.sh` and `zerodowntime.sh` inside the container (Bash runner) |
| `npm run test:runner:ps` | `high.ps1`, `security.ps1`, `rehearsal.ps1`, `roundtrip.ps1`, `promotion.ps1`, `quoting.ps1`, `releases.ps1` and `zerodowntime.ps1` under Windows PowerShell 5.1; psql runs in the container through `psql-shim.ps1` |

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

- **releases** — releases, projects and change kinds on a `zp_lookup_data` table with 100 rows, where project A and project B each add 20 rows and update 10 rows (A: `custom1`/`custom2`, B: `custom7`/`custom8`):
  - prod gets only project B when A is dropped (`deploy --release`), and A goes out later in its own release despite `out_of_order = block`;
  - rollbacks in ST of all of B, B updates only, B inserts only, A inserts only and A updates only (`revert --project --kind`), with `--dry-run`;
  - a scoped revert is refused when a later change outside the scope requires one of its changes or uses a structure it changed;
  - `project`, `release`, `kind`, `requested_by` and `created_by` are recorded in `dmcr.change_log`; registry upgrade; `release list/show`; dropped changes; unknown projects, kinds and releases; kind inference.
- **zerodowntime** — the Releases › Zero-downtime templates (rename, change type, NOT NULL, foreign key, index) written with `${schema}`, as DMCR Web saves them (`fixtures/zero-downtime`, made by `fixtures/make-zero-downtime.js`), on two environments with different schemas: test = `zp_st`, prod = `zp`. Every object lands in the environment's own schema, the dual-write sync triggers work there, `verify all` passes, the `danger_` contracts run as `manual-script` output with no `${...}` left, and `revert to` brings prod back to its original columns.

The extension end-to-end suite (`npm run test:e2e`, in `src/test/e2e`) reuses `psql-shim.ps1` / `psql-shim.sh`.

Each suite prints `RESULT: N passed, M failed` and exits non-zero on any failure.
