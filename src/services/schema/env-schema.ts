/**
 * The schema each environment's changes target ([test] schema = zp_st, [prod] schema = zp), from dmcr.cfg.
 */
import * as fs from 'fs';
import { getUserCfgPath } from '../../storage/runner-paths';
import { parseDmcrIni, cfgEnvList, cfgActiveEnv } from '../../panel/main/handlers/dmcr-cfg';

function parsedCfg(): Record<string, Record<string, string>> {
  const p = getUserCfgPath();
  try { return p && fs.existsSync(p) ? parseDmcrIni(fs.readFileSync(p, 'utf8')) : {}; } catch { return {}; }
}

/** env name -> schema, for the environments that set one. */
export function envSchemaMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of cfgEnvList(parsedCfg())) if (e.schema) out[e.name] = e.schema;
  return out;
}

/** True when changes are written with ${schema} (some environment sets a schema). */
export function usesSchemaPlaceholder(): boolean {
  return Object.keys(envSchemaMap()).length > 0;
}

/**
 * The schema ${schema} means while DMCR generates and self-checks a change: the [test] environment's
 * (where the self-check runs), else the active one's.
 */
export function generationSchema(): string | undefined {
  const parsed = parsedCfg();
  const map = envSchemaMap();
  return map['test'] ?? map[cfgActiveEnv(parsed)] ?? Object.values(map)[0];
}

/** The environment a change is generated and self-checked against: [test] when configured, else the active one. */
export function generationEnv(): string {
  const parsed = parsedCfg();
  const names = cfgEnvList(parsed).map(e => e.name);
  return names.includes('test') ? 'test' : (cfgActiveEnv(parsed) || names[0] || 'test');
}
