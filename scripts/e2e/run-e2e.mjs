// End-to-end tests in a real VS Code extension host (npm run test:e2e).
//
// Needs Docker. Starts a throwaway PostgreSQL 16 container (dmcr-test-pg) and the bundled
// pgsql_mcp server in a Python container (dmcr-mcp-py), creates an
// empty workspace with its own DMCR database file, and runs out/test/e2e in VS Code.
// Uses the local VS Code install when found (or VSCODE_EXE); otherwise @vscode/test-electron
// downloads one.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PG = 'dmcr-test-pg';
const MCP = 'dmcr-mcp-py';        // runs the bundled pgsql_mcp server
const NET = 'dmcr-e2e';
const docker = (...a) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

function localVsCode() {
  if (process.env.VSCODE_EXE) return process.env.VSCODE_EXE;
  const candidates = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft VS Code', 'Code.exe'),
       path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe')]
    : process.platform === 'darwin'
      ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
      : ['/usr/share/code/code'];
  return candidates.find(c => c && fs.existsSync(c));
}

// Optional real-model test: DMCR_E2E_DEEPSEEK_KEY from the environment (on Windows also the
// user-level variable, so a key set with [Environment]::SetEnvironmentVariable works without
// restarting the shell). Never printed.
function deepseekKey() {
  if (process.env.DMCR_E2E_DEEPSEEK_KEY) return process.env.DMCR_E2E_DEEPSEEK_KEY;
  if (process.platform !== 'win32') return '';
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('DMCR_E2E_DEEPSEEK_KEY','User')"], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dmcr-e2e-'));
const ws = path.join(tmp, 'workspace');
fs.mkdirSync(path.join(ws, '.vscode'), { recursive: true });
fs.writeFileSync(path.join(ws, '.vscode', 'settings.json'), JSON.stringify({
  'dmcr.dbPath': path.join(tmp, 'dmcr.db'),
}, null, 2));

let code = 1;
try {
  for (const c of [PG, MCP]) { try { docker('rm', '-f', c); } catch { /* not running */ } }
  try { docker('network', 'rm', NET); } catch { /* none */ }
  docker('network', 'create', NET);
  docker('run', '-d', '--name', PG, '--network', NET, '-e', 'POSTGRES_PASSWORD=dmcrtest', '-e', 'POSTGRES_DB=dmcrtest', 'postgres:16');
  // Install pgsql_mcp the way its README says (pyproject.toml decides the dependency
  // versions). Only the package and its build files are copied, not a local app_mcp.yml.
  const mcpSrc = path.join(repo, 'pgsql_mcp');
  docker('run', '-d', '--name', MCP, '--network', NET, 'python:3.12-slim', 'sleep', 'infinity');
  docker('exec', MCP, 'mkdir', '-p', '/srv/pgsql_mcp');
  for (const f of ['app_mcp', 'log4py', 'pyproject.toml', 'README.md']) {
    docker('cp', path.join(mcpSrc, f), `${MCP}:/srv/pgsql_mcp/${f}`);
  }
  docker('exec', MCP, 'pip', 'install', '-q', '--disable-pip-version-check', '--root-user-action=ignore', '/srv/pgsql_mcp[yaml]');
  for (let i = 0; i < 60; i++) {
    try { docker('exec', PG, 'pg_isready', '-U', 'postgres', '-d', 'dmcrtest', '-h', 'localhost'); break; }
    catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  const shim = path.join(repo, 'scripts', 'runner', 'tests', process.platform === 'win32' ? 'psql-shim.ps1' : 'psql-shim.sh');
  const vscodeExecutablePath = localVsCode();
  console.log(`VS Code: ${vscodeExecutablePath ?? '(download)'}\nworkspace: ${ws}\nreal-model test: ${deepseekKey() ? 'on (DeepSeek)' : 'off (set DMCR_E2E_DEEPSEEK_KEY to run it)'}`);
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: repo,
    extensionTestsPath: path.join(repo, 'out', 'test', 'e2e', 'index'),
    launchArgs: [ws, '--disable-extensions', '--user-data-dir', path.join(tmp, 'user-data'), '--skip-welcome', '--skip-release-notes'],
    extensionTestsEnv: { DMCR_E2E: '1', DMCR_E2E_DEEPSEEK_KEY: deepseekKey(), DMCR_PSQL: shim, DMCR_E2E_MCP_CONTAINER: MCP, DMCR_E2E_MCP_PG: `postgresql://postgres:dmcrtest@${PG}:5432/dmcrtest` },
  });
  code = 0;
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
} finally {
  for (const c of [PG, MCP]) { try { docker('rm', '-f', c); } catch { /* ignore */ } }
  try { docker('network', 'rm', NET); } catch { /* ignore */ }
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
