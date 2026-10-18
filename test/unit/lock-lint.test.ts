import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { lintDeploySql } from '../../src/services/lint/lock-lint';

const rules = (sql: string) => lintDeploySql(sql).map(f => f.rule);

test('flags the locking forms, with the line they start on', () => {
  const f = lintDeploySql(`-- header
CREATE INDEX zap_runs_started_idx ON public.zap_runs (started_at);
ALTER TABLE public.zp_lookup_data ALTER COLUMN custom3 TYPE varchar(50);
ALTER TABLE public.zp_lookup_data ALTER COLUMN name SET NOT NULL;
ALTER TABLE public.zap_runs ADD CONSTRAINT zr_zap_fk FOREIGN KEY (zap_id) REFERENCES public.zaps(id);
ALTER TABLE public.zaps ADD COLUMN created_at timestamptz DEFAULT now();
ALTER TABLE public.zaps ADD CONSTRAINT zaps_name_uq UNIQUE (name);
ALTER TABLE public.zaps RENAME COLUMN owner TO owned_by;
REINDEX TABLE public.zaps;`);
  assert.deepEqual(f.map(x => x.rule), ['index-without-concurrently', 'alter-column-type', 'set-not-null', 'constraint-without-not-valid', 'volatile-default', 'unique-without-index', 'rename', 'reindex-without-concurrently']);
  assert.equal(f[0].line, 2);
  assert.equal(f[1].line, 3);
});

test('the safe forms pass', () => {
  assert.deepEqual(rules(`CREATE INDEX CONCURRENTLY IF NOT EXISTS i ON public.zap_runs (started_at);
ALTER TABLE public.zap_runs ADD CONSTRAINT zr_zap_fk FOREIGN KEY (zap_id) REFERENCES public.zaps(id) NOT VALID;
ALTER TABLE public.zap_runs VALIDATE CONSTRAINT zr_zap_fk;
ALTER TABLE public.zaps ADD COLUMN status_note text DEFAULT 'none';
ALTER TABLE public.zaps ADD CONSTRAINT zaps_name_uq UNIQUE USING INDEX zaps_name_idx;
REINDEX INDEX CONCURRENTLY zaps_name_idx;`), []);
});

test('a table created in the same change is exempt', () => {
  assert.deepEqual(rules(`CREATE TABLE public.zap_events (id bigint, at timestamptz);
CREATE INDEX zap_events_at_idx ON public.zap_events (at);
ALTER TABLE public.zap_events ALTER COLUMN at SET NOT NULL;`), []);
});

test('an index on a materialized view created (or rebuilt) in the same change is exempt', () => {
  assert.deepEqual(rules(`DROP MATERIALIZED VIEW IF EXISTS order_counts;
CREATE MATERIALIZED VIEW order_counts AS SELECT status, count(*) AS n FROM orders GROUP BY status;
CREATE UNIQUE INDEX order_counts_uk ON order_counts (status);`), []);
  assert.deepEqual(rules('CREATE UNIQUE INDEX order_counts_uk ON order_counts (status);'), ['index-without-concurrently']);
});

test('function bodies and comments are not linted', () => {
  assert.deepEqual(rules(`-- CREATE INDEX x ON public.t (a);
CREATE OR REPLACE FUNCTION public.f() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE 'CREATE INDEX y ON public.t (a)';
END;
$fn$;`), []);
});

test('a type change to text / varchar is a notice, not a warning', () => {
  const f = lintDeploySql('ALTER TABLE public.zp_lookup_data ALTER COLUMN custom3 TYPE text USING custom3::text;');
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, 'notice');
  assert.equal(lintDeploySql('ALTER TABLE public.t ALTER COLUMN n TYPE bigint;')[0].severity, 'warning');
});
