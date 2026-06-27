import * as child_process from "child_process";

export type SqlLintResult = {
  ok: boolean;
  msg: string;
  line?: number;
  column?: number;
};

export type RoutineSignature = {
  kind: "function" | "procedure";
  name: string; // schema.name or name
  argsRaw: string; // raw args text
  signature: string; // name(args...)
};

type DmcrParseResult = {
  ok: boolean;
  msg: string;
  line?: number;
  column?: number;
};


function defaultPowerShellExe(): string {
  if (process.platform === "win32") return process.env.DMCR_PWSH || "powershell.exe";
  return process.env.DMCR_PWSH || "pwsh";
}

function tryParseJsonFromText(text: string): unknown | null {
  const t = String(text || "").trim();
  if (!t) return null;

  // Prefer parsing the last JSON-looking line (to tolerate any incidental output).
  const lines = t.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {
      // keep scanning upwards
    }
  }

  // Fallback: try parsing the full stdout.
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function isDmcrParseResult(x: unknown): x is DmcrParseResult {
  const v = x as Partial<DmcrParseResult> | null;
  return !!v && typeof v === "object" && typeof v.ok === "boolean" && typeof v.msg === "string";
}

async function runDmcrParse(sql: string): Promise<DmcrParseResult> {
  const exe = defaultPowerShellExe();

  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    "$sql = [Console]::In.ReadToEnd()",
    "if ([string]::IsNullOrWhiteSpace($sql)) { Write-Output '{\"ok\":false,\"msg\":\"SQL is empty.\"}'; exit 0 }",
    "dmcr parse $sql",
  ].join("; ");

  const args =
    process.platform === "win32"
      ? ["-ExecutionPolicy", "Bypass", "-Command", psScript]
      : ["-Command", psScript];

  return await new Promise<DmcrParseResult>(resolve => {
    const child = child_process.spawn(exe, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    const timeoutMs = 4000;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
      resolve({ ok: false, msg: `dmcr parse timed out after ${timeoutMs}ms.` });
    }, timeoutMs);

    child.stdout.on("data", d => (stdout += d.toString("utf8")));
    child.stderr.on("data", d => (stderr += d.toString("utf8")));

    child.on("error", e => {
      clearTimeout(timer);
      resolve({ ok: false, msg: `Failed to run dmcr parse: ${e.message}` });
    });

    child.on("close", () => {
      clearTimeout(timer);

      const parsed = tryParseJsonFromText(stdout);
      if (isDmcrParseResult(parsed)) return resolve(parsed);

      const msg = (stderr || stdout || "dmcr parse failed.").trim();
      resolve({ ok: false, msg });
    });

    child.stdin.end(sql, "utf8");
  });
}

export async function lintPostgresSql(sqlRaw: string): Promise<SqlLintResult> {
  const sql = String(sqlRaw ?? "").trim();

  if (!sql) return { ok: false, msg: "SQL is empty." };
  if (sql.length > 200_000) return { ok: false, msg: "SQL is too large (> 200k chars). Split it." };

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib = require('libpg-query') as {
      parse: (sql: string) => Promise<unknown>;
    };
    await lib.parse(sql);
    return { ok: true, msg: "Syntax OK (libpg-query / PostgreSQL 17)" };
  } catch (e: unknown) {
    const err = e as { message?: string; sqlDetails?: { message?: string; cursorPosition?: number } };
    const details = err.sqlDetails;
    const rawMsg = details?.message || err.message || String(e);

    let line: number | undefined;
    let column: number | undefined;

    if (details?.cursorPosition != null) {
      // cursorPosition is 1-based character offset into the full SQL string
      const charPos = Math.max(0, details.cursorPosition - 1);
      const before = sql.substring(0, charPos);
      const lines = before.split("\n");
      line   = lines.length;
      column = lines[lines.length - 1].length + 1;
    }

    // Strip leading "ERROR:  " prefix PostgreSQL appends, keep it short
    const brief = rawMsg.replace(/^ERROR:\s*/i, "").split("\n")[0].slice(0, 200);

    return { ok: false, msg: `Parse error: ${brief}`, line, column };
  }
}

/**
 * Strip DMCR transaction/session wrappers so downstream tools that don't
 * understand full PG syntax (e.g. prompt builders) see the core statement.
 * Note: lintPostgresSql no longer needs this — libpg-query handles it all.
 */
function stripDmcrWrappers(sql: string): string {
  // Remove line comments
  let s = sql.replace(/--[^\n]*/g, '');
  // Remove block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove SET LOCAL …; lines
  s = s.replace(/SET\s+LOCAL\s+[^;]+;/gi, '');
  // Remove bare BEGIN; / COMMIT; / ROLLBACK;
  s = s.replace(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/gi, '');
  // Remove DO $$ … $$ PL/pgSQL blocks (parser doesn't support them)
  s = s.replace(/DO\s+\$\$[\s\S]*?\$\$/gi, '');
  return s.trim() || sql.trim();
}

/**
 * Best-effort detection for:
 *   CREATE [OR REPLACE] FUNCTION schema.name(args...)
 *   CREATE [OR REPLACE] PROCEDURE schema.name(args...)
 *
 * Returns a compact signature string for prompting.
 */
export function detectCreateRoutineSignature(sqlRaw: string): RoutineSignature | null {
  const sql = String(sqlRaw ?? "");

  const m = /\bcreate\s+(?:or\s+replace\s+)?(function|procedure)\b/i.exec(sql);
  if (!m || m.index == null) return null;

  const kind = m[1].toLowerCase() as "function" | "procedure";
  let i = m.index + m[0].length;

  const len = sql.length;
  const isWs = (c: string) => c === " " || c === "\t" || c === "\r" || c === "\n";

  while (i < len && isWs(sql[i])) i++;

  const readIdent = (): string | null => {
    if (i >= len) return null;

    if (sql[i] === '"') {
      i++;
      let out = "";
      while (i < len) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            out += '"';
            i += 2;
            continue;
          }
          i++;
          return `"${out}"`;
        }
        out += sql[i++];
      }
      return null;
    }

    const start = i;
    while (i < len) {
      const ch = sql[i];
      const ok =
        (ch >= "a" && ch <= "z") ||
        (ch >= "A" && ch <= "Z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "_" ||
        ch === "$";
      if (!ok) break;
      i++;
    }
    if (i === start) return null;
    return sql.slice(start, i);
  };

  const parts: string[] = [];
  const first = readIdent();
  if (!first) return null;
  parts.push(first);

  while (true) {
    while (i < len && isWs(sql[i])) i++;
    if (sql[i] !== ".") break;
    i++;
    while (i < len && isWs(sql[i])) i++;
    const next = readIdent();
    if (!next) break;
    parts.push(next);
  }

  const name = parts.join(".");

  while (i < len && isWs(sql[i])) i++;
  if (sql[i] !== "(") return { kind, name, argsRaw: "", signature: `${name}()` };

  const startArgs = i + 1;
  i++; // consume '('
  let depth = 1;
  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < len) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      i++;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === "-" && next === "-") {
        inLineComment = true;
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        inBlockComment = true;
        i += 2;
        continue;
      }
    }

    if (!inDouble && ch === "'") {
      if (inSingle && next === "'") {
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      i++;
      continue;
    }

    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      i++;
      continue;
    }

    if (!inSingle && !inDouble) {
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          const argsRaw = sql.slice(startArgs, i);
          const compactArgs = argsRaw.replace(/\s+/g, " ").trim();
          return {
            kind,
            name,
            argsRaw: argsRaw.trim(),
            signature: `${name}(${compactArgs})`,
          };
        }
      }
    }

    i++;
  }

  return null;
}