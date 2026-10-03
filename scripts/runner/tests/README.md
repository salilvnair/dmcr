# Runner tests

End-to-end tests for `dmcr.sh` and `dmcr.ps1` against a throwaway PostgreSQL 16 container. They need Docker and create and remove a container named `dmcr-test-pg`.

| Command | What runs |
|---|---|
| `npm run test:runner` | `high.sh` and `security.sh` inside the container (Bash runner) |
| `npm run test:runner:ps` | `high.ps1` and `security.ps1` under Windows PowerShell 5.1; psql runs in the container through `psql-shim.ps1` |

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

Each suite prints `RESULT: N passed, M failed` and exits non-zero on any failure.
