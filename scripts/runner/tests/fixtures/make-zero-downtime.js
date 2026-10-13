// Writes fixtures/zero-downtime/: the Releases > Zero-downtime templates for every pattern, written
// with ${schema} exactly as DMCR Web saves them (danger_ when deploy.sql drops something, the change
// id in verify, each contract requiring its expand). Run after `npm run test:unit` (it compiles out-unit):
//   node scripts/runner/tests/fixtures/make-zero-downtime.js
const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '../../../..');
const { buildZeroDowntime } = require(path.join(root, 'out-unit/src/forms/zero-downtime/templates.js'));
const out = path.join(__dirname, 'zero-downtime');
fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
const sets = [
  ['dual-write', { table: '${schema}.zaps', column: 'owner', newColumn: 'owner_name', newType: 'varchar(100)', oldType: 'varchar(100)', oldNotNull: true }],
  ['dual-write', { table: '${schema}.zap_runs', column: 'duration_ms', newColumn: 'duration_ms_big', newType: 'bigint', oldType: 'integer', toNew: '{old}::bigint', toOld: '{new}::integer' }],
  ['not-null', { table: '${schema}.zap_runs', column: 'started_at' }],
  ['foreign-key', { table: '${schema}.zap_runs', column: 'zap_id', refTable: '${schema}.zaps', refColumn: 'id' }],
  ['index', { table: '${schema}.zap_runs', columns: 'zap_id, started_at' }],
];
let n = 0;
for (const [pattern, params] of sets) {
  let prev = null;
  for (const p of buildZeroDowntime(pattern, params)) {
    const id = String(++n).padStart(3, '0') + '_' + (/\bDROP\s+(COLUMN|TABLE)\b/i.test(p.deploySql) ? 'danger_' : '') + p.changeName;
    const dir = path.join(out, id); fs.mkdirSync(dir);
    const apply = s => s.replace(/__DMCR_CHANGE_ID__/g, id);
    fs.writeFileSync(path.join(dir, 'deploy.sql'), apply(p.deploySql));
    fs.writeFileSync(path.join(dir, 'verify.sql'), apply(p.verifySql));
    fs.writeFileSync(path.join(dir, 'revert.sql'), apply(p.revertSql));
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...p.meta, change_id: id, ...(prev ? { requires: [prev] } : {}) }, null, 2) + '\n');
    console.log(id);
    prev = id;
  }
}
