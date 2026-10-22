/**
 * An imported change must deploy what already ran on test, word for word. The AI writes deploy.sql from the file
 * and may "improve" a function on the way (SET search_path FROM CURRENT, another layout); then prod gets a
 * different function than test and Schema Diff shows drift. Every function / procedure / view the file defines
 * is put back into deploy.sql exactly as the file has it. Other statements (a backup before a DML) stay.
 */
import { splitTopLevelStatements } from '../../forms/utils/sql-utils';
import { definedObject, sameObject, stripLeadingComments } from '../../forms/llm/generation/previous-definition';

/** verify.sql failed because the backup table a data change's deploy makes (dmcr.bak_<id>) is not there, however the AI worded it. */
export function isMissingBackup(error: string): boolean {
  return /\bdmcr\.bak_\w+/i.test(error) && /\b(missing|does not exist|not exist|to exist|not found|no such)\b/i.test(error);
}

export function keepFileDefinitions(deploySql: string, fileSql: string): { sql: string; restored: string[] } {
  let sql = deploySql;
  const restored: string[] = [];
  const fileDefs = splitTopLevelStatements(fileSql).map(s => stripLeadingComments(s).trim()).filter(s => definedObject(s));
  for (const want of fileDefs) {
    const obj = definedObject(want)!;
    if (/^drop\b/i.test(want)) continue;
    for (const st of splitTopLevelStatements(sql)) {
      const got = stripLeadingComments(st).trim();
      const o = definedObject(got);
      if (!o || !sameObject(o, obj) || /^drop\b/i.test(got) || got === want) continue;
      if (!sql.includes(got)) continue;   // a comment inside the statement: left as the AI wrote it
      sql = sql.replace(got, () => want);
      restored.push(obj.display);
    }
  }
  return { sql, restored };
}
