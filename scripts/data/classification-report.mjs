// Before/after report for the publication classifier. Read-only.
//   node scripts/data/classification-report.mjs --jsonl docs/journal-audit/articles.jsonl.gz [--out report.json]
//   node --experimental-sqlite scripts/data/classification-report.mjs --db /app/data/fanscope.sqlite [--out report.json]
// "before" = what the homepage counts today (all non-demo records, any type);
// "after"  = the new default scope (formal articles, reasonably confirmed, verified identity).
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import {classifyRecord, CLASSIFIER_VERSION} from '../../api/src/ingest/classify.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith('--') ? [...a, [v.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : a), []));
const policies = JSON.parse(fs.readFileSync(new URL('../../api/config/journal-policies.json', import.meta.url), 'utf8')).journals;

async function* records() {
  if (args.jsonl) {
    const input = fs.createReadStream(args.jsonl).pipe(args.jsonl.endsWith('.gz') ? zlib.createGunzip() : new (await import('node:stream')).PassThrough());
    for await (const line of readline.createInterface({input})) if (line.trim()) yield JSON.parse(line);
  } else if (args.db) {
    const header = Buffer.alloc(20); const fd = fs.openSync(args.db, 'r'); try { fs.readSync(fd, header, 0, 20, 0); } finally { fs.closeSync(fd); }
    if (header[18] === 2 && !fs.existsSync(args.db + '-shm')) throw Error('WAL database without -shm; refusing to create files');
    const {DatabaseSync} = await import('node:sqlite');
    const db = new DatabaseSync(args.db, {readOnly: true});
    try { db.exec('BEGIN'); yield* db.prepare('SELECT a.*, j.title AS journal_title FROM articles a JOIN journals j ON j.id=a.journal_id WHERE a.demo=0').iterate(); db.exec('ROLLBACK'); }
    finally { db.close(); }
  } else throw Error('Use --jsonl <file> or --db <sqlite>');
}

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
const out = {classifierVersion: CLASSIFIER_VERSION, source: args.jsonl || args.db, generatedAt: new Date().toISOString(),
  totals: {before: 0, after: 0}, byGroup: {}, byDocType: {}, byPubStatus: {}, byConfidence: {}, byRule: {}, byJournal: {}, byMonth: {}, byMarket: {}};
for await (const r of records()) {
  if (r.demo === 1 || r.demo === true) continue;
  const c = classifyRecord(r, policies[r.journal_id] || {});
  const month = String(r.publication_date_partial || r.published_online_date || r.publication_date || '').slice(0, 7) || 'undated';
  const j = out.byJournal[r.journal_id] ||= {title: r.journal_title || r.journal_id, before: 0, after: 0, research: 0, review: 0, conference: 0, unconfirmed: 0, non_research: 0, preprint: 0, withAbstract: 0};
  const m = out.byMonth[month] ||= {before: 0, after: 0, conference: 0, unconfirmed: 0};
  const mk = out.byMarket[r.market || 'unknown'] ||= {before: 0, after: 0};
  out.totals.before++; j.before++; m.before++; mk.before++;
  if (c.default_scope) { out.totals.after++; j.after++; m.after++; mk.after++; }
  bump(out.byGroup, c.scope_group); bump(out.byDocType, c.doc_type); bump(out.byPubStatus, c.pub_status); bump(out.byConfidence, c.confidence);
  for (const rule of c.rules) bump(out.byRule, rule);
  bump(j, c.scope_group); if (String(r.abstract || '').trim().length >= 55) j.withAbstract++;
  if (c.scope_group === 'conference') m.conference++; if (c.scope_group === 'unconfirmed') m.unconfirmed++;
}
out.byMonth = Object.fromEntries(Object.entries(out.byMonth).sort());
const text = JSON.stringify(out, null, 2);
if (args.out && args.out !== true) fs.writeFileSync(args.out, text); else console.log(text);
