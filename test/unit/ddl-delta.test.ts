import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { tableDriftMigration, tableAlterStatements, parseCreateTable } from '../../webview-ui/src/utils/ddlDelta';

// the shape get_ddl returns: CREATE TABLE …; then its indexes (the use case 30 drift, test vs prod)
const TEST_DDL = `CREATE TABLE public.zp_lookup_data (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(200) NOT NULL,
    custom3 text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    category text NOT NULL,
    CONSTRAINT zp_lookup_data_pkey PRIMARY KEY (id),
    CONSTRAINT zp_lookup_data_category_chk CHECK ((category = ANY (ARRAY['lookup'::text, 'trigger'::text])))
);
CREATE UNIQUE INDEX zp_lookup_data_code_key ON public.zp_lookup_data USING btree (code);`;

const PROD_DDL = `CREATE TABLE public.zp_lookup_data (
    id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
    code character varying(50) NOT NULL,
    name character varying(200),
    custom3 character varying(100),
    custom6 text,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT zp_lookup_data_pkey PRIMARY KEY (id)
);
CREATE UNIQUE INDEX zp_lookup_data_code_key ON public.zp_lookup_data USING btree (code);
CREATE INDEX zaps_owner_idx ON public.zp_lookup_data USING btree (name);`;

test('parseCreateTable: columns, defaults, NOT NULL and named constraints', () => {
  const t = parseCreateTable(TEST_DDL.split(';\n')[0])!;
  assert.equal(t.name, 'public.zp_lookup_data');
  assert.deepEqual([...t.columns.keys()], ['id', 'code', 'name', 'custom3', 'created_at', 'category']);
  assert.equal(t.columns.get('created_at')!.def, 'now()');
  assert.equal(t.columns.get('created_at')!.notNull, true);
  assert.equal(t.columns.get('custom3')!.type, 'text');
  assert.ok(t.constraints.has('zp_lookup_data_category_chk'));
});

test('tableAlterStatements: the ALTERs that bring prod back to test', () => {
  const out = tableAlterStatements(TEST_DDL.split(';\n')[0], PROD_DDL.split(';\n')[0])!.join('\n');
  assert.match(out, /ALTER TABLE public\.zp_lookup_data ALTER COLUMN custom3 TYPE text USING custom3::text;/);
  assert.match(out, /ALTER COLUMN name SET NOT NULL;/);
  assert.match(out, /ALTER COLUMN created_at SET DEFAULT now\(\);/);
  assert.match(out, /ADD COLUMN IF NOT EXISTS category text NOT NULL;/);
  assert.match(out, /ADD CONSTRAINT zp_lookup_data_category_chk CHECK/);
  // a column only in the target is never dropped silently
  assert.match(out, /-- ALTER TABLE public\.zp_lookup_data DROP COLUMN custom6;/);
  assert.doesNotMatch(out, /^ALTER TABLE .* DROP COLUMN/m);
});

test('tableDriftMigration: an index only in the target is dropped, a shared one left alone', () => {
  const out = tableDriftMigration(TEST_DDL, PROD_DDL).join('\n');
  assert.match(out, /DROP INDEX IF EXISTS public\.zaps_owner_idx;/);
  assert.doesNotMatch(out, /zp_lookup_data_code_key/);
  assert.doesNotMatch(out, /could not be compared/);
});
