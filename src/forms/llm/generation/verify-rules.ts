/**
 * Rules a generated verify.sql must follow, as pure functions (unit-tested).
 *
 * The DMCR guard checks the applied state in one IF block and the reverted state in another;
 * an IF … ELSE branch is not allowed. CASE … ELSE … END is an expression, not a branch, so it
 * is fine — checking a CASE-based function (price by category) naturally uses one.
 */

/** verify.sql without comments; string literals emptied. */
function stripCommentsAndStrings(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** True when verify.sql uses ELSE as an IF branch (outside CASE … END expressions). */
export function verifyHasElseBranch(verifySql: string): boolean {
  let s = stripCommentsAndStrings(verifySql);
  // Innermost CASE … END first (the body crosses no other CASE or END). A CASE expression is
  // removed; a CASE statement (… END CASE) is PL/pgSQL control flow, so its ELSE stays visible.
  const innermost = /\bCASE\b((?:(?!\b(?:CASE|END)\b)[\s\S])*)\bEND\b(\s+CASE\b)?/i;
  for (let i = 0; i < 500 && innermost.test(s); i++) {
    s = s.replace(innermost, (_m, body: string, stmt?: string) => (stmt ? ` CASE_STATEMENT ${body} END_CASE_STATEMENT ` : ' '));
  }
  return /\bELSE\b/i.test(s);
}
