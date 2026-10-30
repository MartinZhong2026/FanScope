// Production read-only inventory (O2 in docs/architecture/V2_DELIVERY_PLAN.md).
// Run INSIDE the API container; reads the script from stdin, never imports app code:
//   sudo docker exec -i fanscope-api node --experimental-sqlite --input-type=module - < scripts/ops/readonly-inventory.mjs
// Opens SQLite read-only in one read transaction. Prints counts and data-quality
// facts only: no emails, names, passwords, paper text, prompts or secret values.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

const file = process.env.DATABASE_PATH;
if (!file || !fs.existsSync(file)) throw Error('DATABASE_PATH is not set or does not exist; stopping');
// Opening a WAL database (header bytes 18-19 = 2) without an existing -shm file
// creates -wal/-shm files. They exist while the API runs; otherwise refuse.
const header = Buffer.alloc(20); {const fd = fs.openSync(file, 'r'); try { fs.readSync(fd, header, 0, 20, 0); } finally { fs.closeSync(fd); }}
if (header[18] === 2 && !fs.existsSync(file + '-shm')) throw Error('WAL database without -shm (API not running?); stopping to avoid creating files');
const size = f => (fs.existsSync(f) ? fs.statSync(f).size : 0);
const db = new DatabaseSync(file, {readOnly: true});
const q = s => '"' + s.replaceAll('"', '""') + '"';
const all = (sql, ...a) => db.prepare(sql).all(...a);
const one = (sql, ...a) => db.prepare(sql).get(...a);
const has = t => !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", t);
const cols = t => new Set(all(`PRAGMA table_info(${q(t)})`).map(c => c.name));
const flag = k => (process.env[k] === undefined ? null : ['true', 'false'].includes(process.env[k]) ? process.env[k] : 'set');

db.exec('BEGIN');
try {
  const out = {
    generatedAt: new Date().toISOString(),
    runtime: {node: process.versions.node, sqlite: one('SELECT sqlite_version() v').v, nodeEnv: process.env.NODE_ENV || null,
      commit: process.env.FANSCOPE_COMMIT || null,
      // Presence only; values are never printed.
      credentialsPresent: Object.fromEntries(['DEEPSEEK_API_KEY', 'RESEND_API_KEY', 'OPENALEX_API_KEY'].map(k => [k, !!process.env[k]])),
      flags: Object.fromEntries(['FANSCOPE_V14_RUNTIME', 'FANSCOPE_AI_AUTO_ENABLED', 'FANSCOPE_ENGLISH_MONITOR', 'SCAN_ON_START', 'AUTO_AI_ANALYSIS',
        'CHINESE_AUTH_IMPORT_ENABLED', 'OPENALEX_ENABLED', 'ENABLE_PUBLIC_SUBSCRIPTIONS'].map(k => [k, flag(k)])),
      scanIntervalMinutes: process.env.SCAN_INTERVAL_MINUTES || null},
    database: {bytes: size(file), walBytes: size(file + '-wal'), pageSize: one('PRAGMA page_size').page_size,
      pageCount: one('PRAGMA page_count').page_count, freelist: one('PRAGMA freelist_count').freelist_count,
      quickCheck: one('PRAGMA quick_check').quick_check, journalMode: one('PRAGMA journal_mode').journal_mode},
    tables: Object.fromEntries(all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map(({name}) => [name, one(`SELECT COUNT(*) n FROM ${q(name)}`).n])),
    migrations: has('schema_migrations') ? all('SELECT version, applied_at FROM schema_migrations ORDER BY applied_at, rowid') : null,
  };
  if (has('articles')) {
    const c = cols('articles');
    const date = "COALESCE(NULLIF(publication_date_partial,''),NULLIF(published_online_date,''),NULLIF(publication_date,''))";
    const suppl = "(lower(coalesce(issue,'')) LIKE '%suppl%' OR lower(coalesce(volume,'')) LIKE '%suppl%')";
    const abs = "length(trim(coalesce(abstract,'')))>=55";
    out.articles = {
      byMarket: all('SELECT market, COUNT(*) n FROM articles WHERE demo=0 GROUP BY market'),
      bySource: all('SELECT market, source, COUNT(*) n FROM articles WHERE demo=0 GROUP BY market, source'),
      byType: c.has('article_type') ? all('SELECT market, article_type, COUNT(*) n FROM articles WHERE demo=0 GROUP BY market, article_type') : null,
      byAnalysisStatus: all('SELECT analysis_status, COUNT(*) n FROM articles WHERE demo=0 GROUP BY analysis_status'),
      byYear: all(`SELECT market, substr(${date},1,4) year, COUNT(*) n, SUM(${abs}) withAbstract, SUM(${suppl}) supplement,
        SUM(coalesce(issue,'')='' AND coalesce(volume,'')='') noVolumeIssue FROM articles WHERE demo=0 GROUP BY market, year ORDER BY market, year`),
      demoRows: one('SELECT COUNT(*) n FROM articles WHERE demo=1').n,
    };
    out.journals = all(`SELECT j.id, j.market, j.source, j.enabled, j.title, j.last_checked, j.last_success,
        CASE WHEN coalesce(j.last_error,'')='' THEN NULL ELSE substr(j.last_error,1,160) END last_error,
        COUNT(a.id) total, SUM(${abs.replaceAll('abstract', 'a.abstract')}) withAbstract,
        SUM(${suppl.replaceAll('issue', 'a.issue').replaceAll('volume', 'a.volume')}) supplement,
        SUM(coalesce(a.issue,'')='' AND coalesce(a.volume,'')='') noVolumeIssue,
        SUM(a.date_precision='day') dayPrecision, MAX(${date.replaceAll('publication_date', 'a.publication_date').replaceAll('published_online_date', 'a.published_online_date')}) latestPublication,
        SUM(a.discovered_at >= datetime('now','-30 days')) discovered30d
      FROM journals j LEFT JOIN articles a ON a.journal_id=j.id AND a.demo=0
      GROUP BY j.id ORDER BY j.market, total DESC`);
  }
  if (has('scan_windows')) out.scanWindows = all('SELECT status, mode, COUNT(*) n, MAX(updated_at) lastUpdate FROM scan_windows GROUP BY status, mode');
  if (has('jobs')) out.recentJobs = all("SELECT kind, status, COUNT(*) n, MAX(start_at) lastStart FROM jobs WHERE start_at >= datetime('now','-14 days') GROUP BY kind, status");
  if (has('analysis_usage_log')) out.aiUsage = all('SELECT status, COUNT(*) requests, SUM(input_tokens) inputTokens, SUM(output_tokens) outputTokens, MAX(created_at) last FROM analysis_usage_log GROUP BY status');
  if (has('analysis_batches')) out.aiBatches = all('SELECT status, COUNT(*) n FROM analysis_batches GROUP BY status');
  if (has('meta')) {
    const control = one("SELECT value FROM meta WHERE key='ai-auto:v14:control'")?.value;
    try { out.aiAutoState = control ? (({state, reason}) => ({state, reason}))(JSON.parse(control)) : null; } catch { out.aiAutoState = 'unparseable'; }
  }
  console.log(JSON.stringify(out, null, 2));
} finally {
  db.exec('ROLLBACK');
  db.close();
}
