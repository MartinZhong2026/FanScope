import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {config,journals} from './config.mjs';
import {normalizedAnalysisText,relevanceScore,classifyArticleType} from './publication-policy.mjs';
import {verifyMigrationsAtStartup,initializeFreshDatabase} from './migrations.mjs';
import {log} from './platform/log.mjs';
fs.mkdirSync(path.dirname(config.dbPath),{recursive:true});
const existed=fs.existsSync(config.dbPath)&&fs.statSync(config.dbPath).size>0;
export const db=new DatabaseSync(config.dbPath);
export function addColumns(table, columns){
 const existing=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name));
 for(const [name,type] of Object.entries(columns))if(!existing.has(name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
const offlineChineseImport=process.env.FANSCOPE_OFFLINE_CHINESE_IMPORT==='true';
if(offlineChineseImport&&path.basename(process.argv[1]||'')!=='chinese-production-import.mjs')throw Error('Offline database mode is reserved for the reviewed Chinese import CLI');
if(!offlineChineseImport){
if(existed){
 const hasMigrations=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
 if(!hasMigrations||!db.prepare("SELECT 1 FROM schema_migrations WHERE version='1.2'").get()){
  const target=config.dbPath+'.pre-v1.2-'+Date.now()+'.sqlite';db.prepare('VACUUM INTO ?').run(target);fs.chmodSync(target,0o600);
 }
}
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS journals (id TEXT PRIMARY KEY,title TEXT NOT NULL,market TEXT NOT NULL,issn TEXT,source TEXT,enabled INTEGER DEFAULT 0,rank_label TEXT,homepage TEXT,last_checked TEXT,last_success TEXT,last_error TEXT,last_count INTEGER DEFAULT 0,checkpoint TEXT);
CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY,journal_id TEXT NOT NULL,market TEXT NOT NULL,title TEXT NOT NULL,doi TEXT,url TEXT,authors TEXT,abstract TEXT,publication_date TEXT,published_year INTEGER,discovered_at TEXT NOT NULL,source TEXT NOT NULL,topics TEXT NOT NULL DEFAULT '[]',matched INTEGER NOT NULL DEFAULT 0,method TEXT,design TEXT,data_origin TEXT,sample_n INTEGER,sample_unit TEXT,evidence TEXT,ai_summary TEXT,analysis_status TEXT NOT NULL DEFAULT 'pending',demo INTEGER NOT NULL DEFAULT 0,FOREIGN KEY(journal_id) REFERENCES journals(id));
CREATE INDEX IF NOT EXISTS idx_articles_market_date ON articles(market, publication_date DESC);
CREATE INDEX IF NOT EXISTS idx_articles_discovery ON articles(discovered_at DESC);
CREATE TABLE IF NOT EXISTS subscribers (id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,topics TEXT NOT NULL,markets TEXT NOT NULL,urgent INTEGER DEFAULT 1,daily INTEGER DEFAULT 1,weekly INTEGER DEFAULT 0,confirmed INTEGER DEFAULT 0,verify_hash TEXT,unsubscribe_hash TEXT,created_at TEXT,confirmed_at TEXT,last_daily TEXT,last_weekly TEXT);
CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY,subscriber_id TEXT,article_id TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,error TEXT,UNIQUE(subscriber_id,article_id,kind));
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,start_at TEXT NOT NULL,end_at TEXT,status TEXT NOT NULL,details TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
// v1.2 additive, repeatable migration. Original rows and credentials are retained.
addColumns('articles',{published_online_date:"TEXT DEFAULT ''",indexed_at:"TEXT DEFAULT ''",date_precision:"TEXT DEFAULT 'unknown'",publisher_landing_url:"TEXT DEFAULT ''",link_provenance:"TEXT DEFAULT ''",analysis_json:"TEXT",analysis_attempts:'INTEGER DEFAULT 0',analysis_error:"TEXT DEFAULT ''",analysis_retry_at:'TEXT',notification_eligible:'INTEGER NOT NULL DEFAULT 0'});
db.exec('CREATE INDEX IF NOT EXISTS idx_articles_journal_url ON articles(journal_id,url)');
addColumns('journals',{rss_url:"TEXT NOT NULL DEFAULT ''"});
addColumns('articles',{published_print_date:"TEXT DEFAULT ''",volume:"TEXT DEFAULT ''",issue:"TEXT DEFAULT ''",issns_json:"TEXT NOT NULL DEFAULT '[]'",source_evidence_json:"TEXT",metadata_fetched_at:"TEXT",source_verification_status:"TEXT NOT NULL DEFAULT 'unverified'",missing_fields_json:"TEXT NOT NULL DEFAULT '{}'"});
addColumns('articles',{publication_date_partial:"TEXT DEFAULT ''"});
addColumns('articles',{chinese_identity_key:"TEXT NOT NULL DEFAULT ''",source_updated_at:"TEXT NOT NULL DEFAULT ''"});
db.exec("CREATE INDEX IF NOT EXISTS idx_chinese_identity ON articles(journal_id,chinese_identity_key) WHERE chinese_identity_key<>''");
addColumns('articles',{article_type:"TEXT NOT NULL DEFAULT 'unknown'",article_type_evidence_json:"TEXT NOT NULL DEFAULT '{}'",abstract_status:"TEXT NOT NULL DEFAULT 'missing'",abstract_source:"TEXT",abstract_checked_at:"TEXT",abstract_error:"TEXT",metadata_supplement_json:"TEXT",relevance_score:'INTEGER NOT NULL DEFAULT 0',analysis_normalized_hash:"TEXT"});
db.exec(`CREATE TABLE IF NOT EXISTS journal_source_evidence (
 id INTEGER PRIMARY KEY AUTOINCREMENT,journal_id TEXT NOT NULL,source TEXT NOT NULL,
 identifier TEXT NOT NULL,checked_at TEXT NOT NULL,verified INTEGER NOT NULL,
 evidence_json TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',
 FOREIGN KEY(journal_id) REFERENCES journals(id)
);
CREATE INDEX IF NOT EXISTS idx_source_evidence ON journal_source_evidence(journal_id,id DESC);`);
addColumns('journals',{rank_system:"TEXT DEFAULT ''",rank_year:"TEXT DEFAULT ''",rank_category:"TEXT DEFAULT ''",rank_evidence_url:"TEXT DEFAULT ''",rank_verification_status:"TEXT DEFAULT 'pending'",watchlist_class:"TEXT DEFAULT 'candidate'"});
db.exec(`CREATE TABLE IF NOT EXISTS scan_windows (
 journal_id TEXT PRIMARY KEY,mode TEXT NOT NULL,range_end TEXT NOT NULL,window_start TEXT NOT NULL,window_end TEXT NOT NULL,cursor TEXT NOT NULL DEFAULT '*',processed INTEGER NOT NULL DEFAULT 0,total INTEGER,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',error TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL);
INSERT OR IGNORE INTO schema_migrations VALUES('1.2',datetime('now'));
CREATE INDEX IF NOT EXISTS idx_articles_publication ON articles(published_online_date DESC,publication_date DESC);`);
// v1.3: append-only migration: durable batches and metered AI activity.
addColumns('articles',{analysis_input_hash:"TEXT DEFAULT ''",analysis_cost_cny:'REAL DEFAULT 0',analysis_model:"TEXT DEFAULT ''"});
db.exec(`CREATE TABLE IF NOT EXISTS analysis_batches (
 id TEXT PRIMARY KEY,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,
 status TEXT NOT NULL DEFAULT 'paused',filter_json TEXT NOT NULL,total INTEGER NOT NULL,
 estimated_cost_limit_cny REAL,completed_at TEXT,error TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS analysis_batch_items (
 batch_id TEXT NOT NULL,article_id TEXT NOT NULL,status TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,error TEXT DEFAULT '',
 updated_at TEXT NOT NULL,PRIMARY KEY(batch_id,article_id),
 FOREIGN KEY(batch_id) REFERENCES analysis_batches(id),
 FOREIGN KEY(article_id) REFERENCES articles(id)
);
CREATE INDEX IF NOT EXISTS idx_ai_batch_items_status ON analysis_batch_items(batch_id,status,next_attempt_at);
CREATE TABLE IF NOT EXISTS analysis_usage_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,article_id TEXT NOT NULL,batch_id TEXT,
 model TEXT NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,
 cost_cny REAL,created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_article ON analysis_usage_log(article_id);
INSERT OR IGNORE INTO schema_migrations VALUES('1.3',datetime('now'));
`);
addColumns('analysis_usage_log',{status:"TEXT NOT NULL DEFAULT 'completed'",error:"TEXT DEFAULT ''",finish_reason:'TEXT',response_length:'INTEGER',error_code:'TEXT'});
// v1.3 stage 3: operator-triggered backfill checkpoints are separate from
// incremental monitor cursors. Existing articles are never cleared.
db.exec(`CREATE TABLE IF NOT EXISTS journal_backfill_jobs (
 id TEXT PRIMARY KEY, journal_id TEXT NOT NULL, from_date TEXT NOT NULL,
 to_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'paused',
 created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
 window_start TEXT NOT NULL DEFAULT '', window_end TEXT NOT NULL DEFAULT '',
 cursor TEXT NOT NULL DEFAULT '*', processed INTEGER NOT NULL DEFAULT 0,
 total INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
 range_end TEXT NOT NULL DEFAULT '', mode TEXT NOT NULL DEFAULT 'backfill',
 error TEXT NOT NULL DEFAULT '', pages_done INTEGER NOT NULL DEFAULT 0,
 added_articles INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
 FOREIGN KEY(journal_id) REFERENCES journals(id)
);
CREATE INDEX IF NOT EXISTS idx_backfill_status ON journal_backfill_jobs(status,created_at);
INSERT OR IGNORE INTO schema_migrations VALUES('1.3-stage3',datetime('now'));
`);
addColumns('journal_backfill_jobs',{source_identifier:"TEXT NOT NULL DEFAULT ''"});
// v1.3 stage 4: opt-in, resumable Crossref title/ISSN discovery.
// These suggestions NEVER enable a journal automatically.
db.exec(`CREATE TABLE IF NOT EXISTS journal_discovery_jobs (
 id TEXT PRIMARY KEY,journal_id TEXT NOT NULL,created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'paused',
 candidate_json TEXT NOT NULL DEFAULT '[]',attempts INTEGER NOT NULL DEFAULT 0,
 last_error TEXT NOT NULL DEFAULT '',finished_at TEXT,
 FOREIGN KEY(journal_id) REFERENCES journals(id)
);
CREATE INDEX IF NOT EXISTS idx_discovery_queue ON journal_discovery_jobs(status,created_at);
INSERT OR IGNORE INTO schema_migrations VALUES('1.3-stage4',datetime('now'));`);
// Quality metadata is additive; the 2025 corpus and every AI result remain.
if(!db.prepare("SELECT 1 FROM schema_migrations WHERE version='trends-2026-quality'").get()){
 db.exec('BEGIN IMMEDIATE');try{
 for(const a of db.prepare('SELECT id,title,abstract,source,source_evidence_json FROM articles').iterate()){
  let e={};try{e=JSON.parse(a.source_evidence_json||'{}')}catch{}
  const type=classifyArticleType(e.publication_types||[],a.source,a.title);
  db.prepare('UPDATE articles SET relevance_score=?,article_type=?,article_type_evidence_json=?,abstract_status=?,abstract_source=? WHERE id=?').run(relevanceScore(a.title,a.abstract),type.article_type,JSON.stringify(type.evidence),(a.abstract||'').trim().length>=55?'available':'missing',a.abstract?a.source:null,a.id);
 }
 db.prepare("INSERT INTO schema_migrations VALUES('trends-2026-quality',datetime('now'))").run();
 db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error}
}
// Re-evaluate derived types when the conservative rules change. Preserve raw
// provider evidence and every existing analysis/cache; workers revalidate queues.
if(!db.prepare("SELECT 1 FROM schema_migrations WHERE version='trends-2026-types-v3'").get()){
 db.exec('BEGIN IMMEDIATE');try{
 for(const a of db.prepare("SELECT id,title,source,article_type_evidence_json FROM articles WHERE article_type_evidence_json<>'{}'").iterate()){
  let e;try{e=JSON.parse(a.article_type_evidence_json)}catch{continue}
  const type=classifyArticleType(e.raw_types||e.raw_labels||e.type_evidence?.raw_labels||[],e.provider||e.source||a.source,a.title);
  db.prepare('UPDATE articles SET article_type=?,article_type_evidence_json=? WHERE id=?').run(e.conflict?'unknown':type.article_type,JSON.stringify({...e,classification:type.evidence}),a.id);
 }
 db.prepare("INSERT INTO schema_migrations VALUES('trends-2026-types-v3',datetime('now'))").run();db.exec('COMMIT');
 }catch(error){db.exec('ROLLBACK');throw error}
}
// Existing v1.2 analyses are valid cached assets. A fingerprint makes later
// source-content changes detectable without forcing a mass paid reanalysis.
const old=db.prepare("SELECT id,title,abstract FROM articles WHERE analysis_status='analyzed' AND analysis_json IS NOT NULL AND COALESCE(analysis_input_hash,'')='' ").iterate();
const stamp=db.prepare('UPDATE articles SET analysis_input_hash=? WHERE id=?');
for(const a of old)stamp.run(crypto.createHash('sha256').update(`${a.title||''}\n${(a.abstract||'').slice(0,7000)}`).digest('hex'),a.id);
// One-time normalization fingerprint for unchanged legacy analyses; never
// overwrite their cached result or original input fingerprint.
for(const a of db.prepare("SELECT * FROM articles WHERE analysis_status='analyzed' AND analysis_json IS NOT NULL AND analysis_normalized_hash IS NULL").all()){
 const legacy=crypto.createHash('sha256').update(`${a.title||''}\n${(a.abstract||'').slice(0,7000)}`).digest('hex');
 if(a.analysis_input_hash===legacy)db.prepare('UPDATE articles SET analysis_normalized_hash=? WHERE id=?').run(crypto.createHash('sha256').update(normalizedAnalysisText(a)).digest('hex'),a.id);
}
const upsert=db.prepare(`INSERT INTO journals(id,title,market,issn,source,enabled,rank_label,homepage) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,market=excluded.market,rank_label=excluded.rank_label`);
for(const j of journals){
 upsert.run(j.id,j.title,j.market,j.issn||'',j.source,j.enabled?1:0,j.rank_label||'待核验',j.homepage||'');
 db.prepare("UPDATE journals SET rank_system=?,rank_year=?,rank_category=?,rank_evidence_url=?,watchlist_class=? WHERE id=? AND rank_verification_status!='verified'").run(j.rank_system||'',j.rank_year||'',j.rank_category||'',j.rank_evidence_url||'',j.watchlist_class||'candidate',j.id);
}
// Seed only a newly added URL; never overwrite operator edits or source state.
for(const j of journals)if(j.rss_url)db.prepare("UPDATE journals SET rss_url=? WHERE id=? AND rss_url='' AND NOT EXISTS(SELECT 1 FROM schema_migrations WHERE version='rss-url')").run(j.rss_url,j.id);
db.exec("INSERT OR IGNORE INTO schema_migrations VALUES('rss-url',datetime('now'))");
db.exec('CREATE INDEX IF NOT EXISTS idx_articles_doi_v14 ON articles(doi); CREATE INDEX IF NOT EXISTS idx_articles_url_v14 ON articles(url)');
// K3: an existing database is never migrated by startup; this check is read-only
// and refuses pending or edited migrations (apply them with migrate-cli.mjs).
// A database file this process just created has no data and gets the full schema.
if(existed)verifyMigrationsAtStartup(db,{warn:fields=>log('warn','migrations.database_ahead',fields)});
else initializeFreshDatabase(db);// recorded in the ledger; never a production path
}
export const now=()=>new Date().toISOString();
export const sql={
 getArticle:db.prepare('SELECT id,title,doi,url,authors,abstract,publication_date,discovered_at,journal_id,market,topics,matched,method,design,data_origin,sample_n,sample_unit,evidence,ai_summary,analysis_status,demo FROM articles WHERE id=?'),
 insertArticle:db.prepare(`INSERT OR IGNORE INTO articles(id,journal_id,market,title,doi,url,authors,abstract,publication_date,published_year,discovered_at,source,topics,matched,analysis_status,demo) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
 journal:db.prepare('SELECT * FROM journals WHERE id=?'),
 logJob:db.prepare('INSERT INTO jobs(kind,start_at,status,details) VALUES(?,?,?,?)'),
 finishJob:db.prepare('UPDATE jobs SET end_at=?,status=?,details=? WHERE id=?'),
};
export function safelyClose(){ db.close(); }
