import * as vscode from "vscode";
import * as cp from "child_process";

export interface TableInfo {
  schema: string;
  table: string;
  columns: { name: string; type: string; nullable: boolean }[];
}

export async function introspectTable(
  tableFqn: string,
  token: vscode.CancellationToken
): Promise<TableInfo | null> {

  const cfg = vscode.workspace.getConfiguration("dmcr");
  const psqlPath = cfg.get<string>("psqlPath", "psql");
  const conn = cfg.get<string>("connection");

  if (!conn) {
    throw new Error("dmcr.connection not configured for DB introspection");
  }

  const [schema, table] = tableFqn.includes(".")
    ? tableFqn.split(".")
    : ["public", tableFqn];

  const sql = `
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_schema='${schema}'
  AND table_name='${table}'
ORDER BY ordinal_position;
`;

  const cmd = `"${psqlPath}" "${conn}" -X -t -A -c "${sql.replace(/\n/g, " ")}"`;

  const out = cp.execSync(cmd, { encoding: "utf8" }).trim();
  if (!out) return null;

  const columns = out.split("\n").map(line => {
    const [name, type, nullable] = line.split("|");
    return {
      name,
      type,
      nullable: nullable === "YES"
    };
  });

  return { schema, table, columns };
}
