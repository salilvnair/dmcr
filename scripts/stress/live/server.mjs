// Live dashboard for the DMCR stress run.
//   node scripts/stress/live/server.mjs [port]      (default 7788)
// Streams the run's event log (NDJSON written by chain.ps1) over Server-Sent Events and
// polls the test database (docker container dmcr-test-pg) for applied changes and row counts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || 7788);
const LOG = process.env.DMCR_LIVE_LOG || path.join(os.tmpdir(), 'dmcr-live', 'events.ndjson');
const PG = 'dmcr-test-pg';
const CONN = 'postgresql://postgres:dmcrtest@localhost:5432/dmcrtest';

function psqlJson(sql) {
  return new Promise(resolve => {
    execFile('docker', ['exec', '-i', PG, 'psql', CONN, '-X', '-t', '-A', '-c', sql], { timeout: 8000 }, (err, out) => {
      if (err) { resolve(null); return; }
      try { resolve(JSON.parse(out.trim() || 'null')); } catch { resolve(null); }
    });
  });
}

const DB_SQL = `SELECT json_build_object(
  'applied', coalesce((SELECT json_agg(json_build_object('id', change_id, 'at', applied_at, 'actor', actor) ORDER BY change_id)
                       FROM dmcr.change_log), '[]'::json),
  'tables', coalesce((SELECT json_agg(json_build_object('name', relname, 'rows', n_live_tup) ORDER BY relname)
                      FROM pg_stat_user_tables WHERE schemaname IN ('shop', 'public') AND relname NOT LIKE 'events_%'), '[]'::json),
  'lock', (SELECT json_build_object('holder', holder, 'since', acquired_at) FROM dmcr.deploy_lock WHERE lock_id = 1),
  'waiting', (SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'),
  'size', pg_size_pretty(pg_database_size(current_database()))
)`;
const DB_SQL_EMPTY = `SELECT json_build_object('applied', '[]'::json, 'tables', '[]'::json, 'lock', null, 'waiting', 0, 'size', pg_size_pretty(pg_database_size(current_database())))`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(here, 'dashboard.html')));
    return;
  }
  if (req.url === '/db') {
    let data = await psqlJson(DB_SQL);
    if (!data) data = await psqlJson(DB_SQL_EMPTY);   // registry not created yet / container starting
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data ?? { offline: true }));
    return;
  }
  if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    let pos = 0, buf = '';
    const pump = () => {
      let size = 0;
      try { size = fs.statSync(LOG).size; } catch { return; }
      if (size < pos) { pos = 0; buf = ''; res.write('event: reset\ndata: {}\n\n'); }   // a new run started
      if (size === pos) return;
      const fd = fs.openSync(LOG, 'r');
      const chunk = Buffer.alloc(size - pos);
      fs.readSync(fd, chunk, 0, chunk.length, pos);
      fs.closeSync(fd);
      pos = size;
      buf += chunk.toString('utf8').replace(/^﻿/, '');
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) { if (l.trim()) res.write(`data: ${l.trim()}\n\n`); }
    };
    pump();
    const t = setInterval(pump, 250);
    const ka = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => { clearInterval(t); clearInterval(ka); });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(port, '127.0.0.1', () => console.log(`DMCR live dashboard: http://127.0.0.1:${port}  (log: ${LOG})`));
