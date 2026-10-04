"""Writes the change folders of the test → prod release scenario, one release at a time,
the way a team adds them to the changes directory:

  python make-release.py <changes_dir> r1    001-003  table + price function v1 + 200k rows
  python make-release.py <changes_dir> r2    004-006  status column (DDL + DML) + function v2 + 90k rows
  python make-release.py <changes_dir> r2b   next id  10k rows (written after the snapshot change)

Release 1 → 200k rows, release 2 → +100k (90k + 10k). Reverting prod to the change before
the 10k load leaves 290k. fn_price v2 replaces v1 and its revert restores v1 exactly; every
verify.sql checks the applied state and the reverted state, so `dmcr test` proves it.
"""
import os
import sys


def guard(cid, applied, reverted, what):
    # Each state's checks sit in their own branch: PL/pgSQL parses a condition only when it runs.
    return f"""DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM dmcr.change_log WHERE change_id = '{cid}') THEN
    IF NOT ({applied}) THEN RAISE EXCEPTION '{cid}: {what} not as deployed'; END IF;
  ELSE
    IF NOT ({reverted}) THEN RAISE EXCEPTION '{cid}: {what} not as before'; END IF;
  END IF;
END $$;
"""


def load(cid, batch, n, prefix):
    deploy = f"""-- {n} rows, batch '{batch}'
INSERT INTO shop.zp_lookup_data (code, category, amount, batch)
SELECT '{prefix}-' || lpad(g::text, 6, '0'),
       (ARRAY['standard', 'premium', 'basic', 'bulk'])[1 + g % 4],
       round((g % 1000) / 7.0 + 1, 2),
       '{batch}'
FROM generate_series(1, {n}) AS g;
"""
    revert = f"DELETE FROM shop.zp_lookup_data WHERE batch = '{batch}';\n"
    cnt = f"(SELECT count(*) FROM shop.zp_lookup_data WHERE batch = '{batch}')"
    return cid, deploy, guard(cid, f"{cnt} = {n}", f"{cnt} = 0", f"{n} rows of batch {batch}"), revert


FN_V1 = """CREATE OR REPLACE FUNCTION shop.fn_price(p_amount numeric, p_category text)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$ SELECT round(p_amount * 1.10, 2) $$;
"""

FN_V2 = """CREATE OR REPLACE FUNCTION shop.fn_price(p_amount numeric, p_category text)
RETURNS numeric
LANGUAGE sql IMMUTABLE
AS $$ SELECT round(p_amount * CASE p_category WHEN 'premium' THEN 1.18 ELSE 1.12 END, 2) $$;
"""

FN_EXISTS = "to_regprocedure('shop.fn_price(numeric,text)') IS NOT NULL"
COL_STATUS = ("EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'shop' "
              "AND table_name = 'zp_lookup_data' AND column_name = 'status')")

RELEASES = {
    'r1': [
        ('001_create_zp_lookup_data', """CREATE SCHEMA IF NOT EXISTS shop;
CREATE TABLE shop.zp_lookup_data (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       varchar(40)   NOT NULL UNIQUE,
  category   text          NOT NULL,
  amount     numeric(12,2) NOT NULL CHECK (amount > 0),
  batch      text          NOT NULL,
  created_at timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX idx_zp_lookup_data_category ON shop.zp_lookup_data (category);
""", guard('001_create_zp_lookup_data', "to_regclass('shop.zp_lookup_data') IS NOT NULL",
           "to_regclass('shop.zp_lookup_data') IS NULL", 'table shop.zp_lookup_data'),
         """DROP TABLE shop.zp_lookup_data;
DROP SCHEMA IF EXISTS shop;
"""),
        ('002_create_fn_price', FN_V1,
         guard('002_create_fn_price', FN_EXISTS, f"NOT {FN_EXISTS}", 'function shop.fn_price'),
         "DROP FUNCTION shop.fn_price(numeric, text);\n"),
        load('003_load_r1_200k', 'r1', 200000, 'R1'),
    ],
    'r2': [
        ('004_add_status', """ALTER TABLE shop.zp_lookup_data ADD COLUMN status text NOT NULL DEFAULT 'active';
UPDATE shop.zp_lookup_data SET status = 'review' WHERE category = 'bulk';
""", guard('004_add_status',
           f"{COL_STATUS} AND (SELECT count(*) FROM shop.zp_lookup_data WHERE status = 'review' AND batch = 'r1') = 50000",
           f"NOT {COL_STATUS}", 'column status and its backfill'),
         "ALTER TABLE shop.zp_lookup_data DROP COLUMN status;\n"),
        ('005_fn_price_v2', "-- v2: premium 18%, everything else 12% (v1: 10% for all)\n" + FN_V2,
         guard('005_fn_price_v2',
               "shop.fn_price(100, 'premium') = 118.00 AND shop.fn_price(100, 'standard') = 112.00",
               "shop.fn_price(100, 'premium') = 110.00 AND shop.fn_price(100, 'standard') = 110.00",
               'fn_price version'),
         "-- back to v1, exactly as 002 created it\n" + FN_V1),
        load('006_load_r2a_90k', 'r2a', 90000, 'R2A'),
    ],
    'r2b': [
        load('{next}_load_r2b_10k', 'r2b', 10000, 'R2B'),
    ],
}


def next_id(changes_dir):
    nums = [int(n[:3]) for n in os.listdir(changes_dir) if n[:3].isdigit() and n[3:4] == '_']
    return f"{(max(nums) if nums else 0) + 1:03d}"


def main():
    changes_dir, release = sys.argv[1], sys.argv[2]
    os.makedirs(changes_dir, exist_ok=True)
    for cid, deploy, verify, revert in RELEASES[release]:
        if '{next}' in cid:
            real = cid.replace('{next}', next_id(changes_dir))
            verify, deploy, revert = (s.replace(cid, real) for s in (verify, deploy, revert))
            cid = real
        d = os.path.join(changes_dir, cid)
        if os.path.exists(d):
            print(f"exists  {cid}")
            continue
        os.makedirs(d)
        for name, body in (('deploy.sql', deploy), ('verify.sql', verify), ('revert.sql', revert)):
            with open(os.path.join(d, name), 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(body)
        print(f"wrote   {cid}")


if __name__ == '__main__':
    main()
