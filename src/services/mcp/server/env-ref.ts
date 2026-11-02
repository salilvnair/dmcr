import * as fs from 'fs';
import { getUserCfgPath } from '../../../storage/runner-paths';
import { parseDmcrIni } from '../../../panel/main/handlers/dmcr-cfg';
import { retrieveRawSecret } from '../../llm/core/secret-store';

/**
 * An MCP server's environment value `@env:<name>` is that DMCR Config environment's database URL:
 * the URL from dmcr.cfg with its password from the OS keychain (dmcr.<name>Password), filled in when the
 * server starts. So the test / prod connection is entered once (Settings > DMCR Config), never copied.
 */
export const ENV_REF = /^@env:([A-Za-z][A-Za-z0-9_-]*)$/;

export async function dmcrEnvConnUrl(name: string): Promise<string | undefined> {
  const cfgPath = getUserCfgPath();
  if (!cfgPath || !fs.existsSync(cfgPath)) return undefined;
  const url = (parseDmcrIni(fs.readFileSync(cfgPath, 'utf8'))[name]?.['conn'] ?? '').trim();
  if (!url) return undefined;
  const password = await retrieveRawSecret(`dmcr.${name}Password`);
  if (!password) return url;
  try { const u = new URL(url); u.password = password; return u.toString(); } catch { return url; }
}

/** The schema of a DMCR Config environment (its search_path), when it is a plain identifier; '' otherwise */
export function dmcrEnvSchema(name: string): string {
  const cfgPath = getUserCfgPath();
  if (!cfgPath || !fs.existsSync(cfgPath)) return '';
  const schema = (parseDmcrIni(fs.readFileSync(cfgPath, 'utf8'))[name]?.['schema'] ?? '').trim().toLowerCase();
  return /^[a-z_][a-z0-9_$]*$/.test(schema) ? schema : '';
}

export async function resolveEnvRefs(env: Record<string, string> | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let schema = '';
  for (const [k, v] of Object.entries(env ?? {})) {
    const m = ENV_REF.exec(String(v).trim());
    out[k] = m ? (await dmcrEnvConnUrl(m[1])) ?? v : v;
    if (m && !schema) schema = dmcrEnvSchema(m[1]);
  }
  // the environment's schema for every session, as the runner sets it (search_path = <schema>,public): a query
  // for qs_item on test reads zp_st.qs_item, never public.qs_item. PGOPTIONS reaches libpq (psycopg) as is.
  if (schema && !out['PGOPTIONS']) out['PGOPTIONS'] = `-c search_path=${schema},public`;
  return out;
}
