// Structured JSON-lines logging with request correlation and redaction.
// Dependency-free on purpose: entry points such as v14-server.mjs clear
// credentials from process.env before config.mjs is imported, so this module
// must not import config.mjs. It never touches the database (the release
// controller treats any startup database write as a failed deployment).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AsyncLocalStorage} from 'node:async_hooks';

const context = new AsyncLocalStorage();
// notice = normal but significant (service lifecycle); always shown at the default threshold.
const levels = {debug: 10, info: 20, notice: 25, warn: 30, error: 40};
// Key names are normalised to lower_snake before matching, so "X-Admin-Key"
// and "apiKey" are both caught while counters such as input_tokens are not.
const SENSITIVE_KEY = /(^|_)(pass|password|passwd|secret|token|api_?key|authorization|cookie|credential|admin_?key|session)$/;
// Free-text research content is replaced by its length and a short hash.
const CONTENT_KEY = /^(body|text|content|prompt|messages|abstract|manuscript|transcript|html|raw|response|completion|quote|source_quote|note|summary|chat|comment|reply|answer|question|query|q|evidence)$/;
// Positive metadata schema: a field name or ASCII spelling does not establish
// that a string is safe. Unknown strings AND unknown field names are summarized.
const enumFields = new Map(Object.entries({
  error_class: ['Error','TypeError','SyntaxError','RangeError','ReferenceError','URIError','EvalError','AggregateError','TimeoutError','AbortError','NonError'],
  provider: ['deepseek','DeepSeek','crossref','Crossref','resend','Europe PMC','openalex'],
  host: ['api.deepseek.com','api.crossref.org','api.resend.com','api.openalex.org','www.ebi.ac.uk'],
  market: ['international','chinese'], source: ['crossref','rss','manual'],
  method: ['GET','HEAD','POST','PATCH','DELETE','PUT','OPTIONS'],
  status: ['ok','partial','failed','success','busy','paused','analyzed'],
  entry: ['server','v14','staged-recovery'], blocked: ['staged-recovery'],
  signal: ['SIGTERM','SIGINT'], kind: ['urgent','daily','weekly'],
  worker: ['admin-scan','document-recovery','scan','journal-discovery','journal-backfill','automatic-ai','analysis-batch','digest'],
  purpose: ['abstract_extraction'], model: ['deepseek-flash','deepseek-chat','deepseek-reasoner'],
  finish_reason: ['stop','length','content_filter','tool_calls','insufficient_system_resource','other'],
  stage: ['request','fetch','parse','scan','send','extract','analyze'],
  redacted: ['content','credential'],
}).map(([key, values]) => [key, new Set(values)]));
const ERROR_CODES = new Set(['scan_budget_paused','request_uncertain','invalid_json','length','empty_content',
  'unexpected_finish_reason','missing_analysis','timeout','aborted','validation_error','rate_limit_exceeded',
  'invalid_api_key','insufficient_balance','ENOTFOUND','EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT',
  'EPIPE','ENOENT','EACCES','ENOSPC','ERR_SQLITE_ERROR','ERR_INVALID_ARG_TYPE','ERR_OUT_OF_RANGE',
  'UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_SOCKET']);
const numericFields = new Set(('status duration_ms attempt attempts retry_after port count length input_tokens output_tokens '
  + 'new_count scanned failed journals partial sent usage_log_id max_bytes interval_minutes line column').split(' '));
const booleanFields = new Set(('retryable backfill ai_enabled mail paid legacy_workers english_monitor history_workers ai monitor').split(' '));
const idFields = new Set(['job_id','batch_id','article_id','document_id','subscriber_id','llm_call_id','request_id']);
const objectFields = new Set(['upstream','schema','in_flight','flags','message_redacted','stack_redacted','redacted_fields']);
const contentFields = new Set(['message','detail','reason','cause']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const journalId = v => /^(candidate-\d{1,3}|ageing-society|gerontologist|geron-b|ssm|jmir|soc-security-cn|soc-review-cn|public-admin-cn|china-social-sciences|management-world)$/.test(v);
const errorCode = v => typeof v === 'string' && (ERROR_CODES.has(v) || /^http_[1-5]\d{2}$/.test(v));
const routeParts = new Set(('api admin lab health topics journals articles stats research system-status chinese-diagnostics '
  + 'subscriptions request confirm unsubscribe login logout password users projects manuscripts members meetings documents '
  + 'updates managers workspace milestones events suggestions import-confirm import analysis-batches start pause cancel retry '
  + 'preview status coverage sources onboarding discover discovery backfill automatic-ai control metadata supplement openalex '
  + 'chinese-imports catalog chinese-sources chinese-ingestion exports export approve reject download file brief feeds search '
  + 'settings preferences notes tasks evidence quality summary reports analyze retry-analysis '
  + 'activate ai-auto ai-auto-status analysis-coverage chinese-batches chinese-import chinese-jobs chinese-source '
  + 'digest enrich-metadata enrich-openalex files import-preview inspect journal-backfill-status journal-backfills '
  + 'journal-discoveries journal-review journal-source journal-source-status licenses me metadata-candidates overview '
  + 'ready research-brief research-comparison review review-queue rss scan start-all test text').split(' '));
const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const startedAt = new Date().toISOString();
let sink = line => process.stdout.write(line + '\n');
const fileState = {day: '', disabledUntil: 0, capped: false};

export const processStartedAt = startedAt;
export function setLogSink(fn) { const previous = sink; sink = fn; return previous; }
export function withRequestContext(ctx, fn) { return context.run(ctx, fn); }
export function currentRequestId() { return context.getStore()?.request_id; }

export function requestIdFrom(value) {
  const v = String(value || '');
  // External correlation headers are untrusted text. Echo a canonical UUID only.
  return UUID.test(v) ? v : crypto.randomUUID();
}

// Collapse identifiers so access logs group by route, not by record.
export function routeTemplate(pathname) {
  return String(pathname || '/').split('?')[0].split('/').slice(0, 16).map(part =>
    !part || routeParts.has(part) ? part : ':id').join('/').slice(0, 200);
}

function contentSummary(value) {
  const seen = new WeakSet();
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value, (_, v) => {
      if (typeof v === 'bigint') return String(v);
      if (v && typeof v === 'object') { if (seen.has(v)) return '[circular]'; seen.add(v); }
      return v;
    });
  } catch { text = '[unserializable]'; }
  text ??= '[unsupported]';
  return {redacted: 'content', length: text.length, sha256: crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)};
}
const normaliseKey = k => String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();

function safeString(key, value) {
  if (enumFields.get(key)?.has(value)) return true;
  if (['error_code','cause_code','code'].includes(key)) return errorCode(value);
  if (idFields.has(key)) return UUID.test(value) || /^\d{1,16}$/.test(value);
  if (['journal_id','scope'].includes(key)) return journalId(value) || (key === 'scope' && value === 'all');
  if (['node','sqlite','version'].includes(key)) return /^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value);
  if (['commit','sha256'].includes(key)) return /^(?:[0-9a-f]{12}|[0-9a-f]{40}|[0-9a-f]{64}|unknown)$/.test(value);
  if (key === 'started_at') return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value);
  return false;
}

export function redact(value, depth = 0, field = '') {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return safeString(field, value) ? value : contentSummary(value);
  if (typeof value === 'bigint') return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n ? Number(value) : contentSummary(value);
  if (depth >= 4) return '[depth-limit]';
  if (value instanceof Error) return depth ? contentSummary({name:value.name,message:value.message}) : errorFields(value);
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {}, hidden = [];
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
      const key = normaliseKey(k);
      if (SENSITIVE_KEY.test(key)) hidden.push({redacted: 'credential'});
      else if (CONTENT_KEY.test(key) || contentFields.has(key)) out[k] = contentSummary(v);
      else if (key === 'stack') out[k] = Array.isArray(v) ? v.map(sourceLocation).filter(Boolean).slice(0, 6) : contentSummary(v);
      else if (key === 'route' && typeof v === 'string') out[k] = routeTemplate(v);
      else if (key === 'retry_after' && typeof v === 'string' && /^\d{1,6}$/.test(v)) out[k] = Number(v);
      else if (enumFields.has(key) || numericFields.has(key) || booleanFields.has(key) || idFields.has(key) || objectFields.has(key)
        || ['error_code','cause_code','code','journal_id','scope','node','sqlite','version','commit','sha256','started_at'].includes(key)) out[k] = redact(v, depth + 1, key);
      else hidden.push(contentSummary({[k]: v}));
    }
    if (hidden.length) out.redacted_fields = [...(Array.isArray(out.redacted_fields) ? out.redacted_fields : []), ...hidden];
    return out;
  }
  return contentSummary(value);
}

// Keep only locations of existing shipped source/test files. Never emit function
// names, eval snippets, arbitrary paths or user-supplied stack frame text.
function sourceLocation(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^((?:src|test)\/[A-Za-z0-9_./-]+\.mjs):(\d+):(\d+)$/);
  return m && !m[1].split('/').includes('..') && fs.existsSync(path.join(apiRoot, m[1])) ? value : null;
}

function stackLocations(stack) {
  const out = [];
  for (const line of String(stack || '').split('\n').slice(1, 30)) {
    const match = line.match(/(file:\/\/\/[^\s()]+):(\d+):(\d+)\)?$/);
    if (!match) continue;
    try {
      const file = fileURLToPath(match[1]), relative = path.relative(apiRoot, file).replaceAll('\\', '/');
      const location = sourceLocation(`${relative}:${match[2]}:${match[3]}`);
      if (location) out.push(location);
    } catch {}
    if (out.length === 6) break;
  }
  return out;
}

export function errorFields(error) {
  const e = error instanceof Error ? error : {name: 'NonError', message: error};
  const status = Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 ? e.status : undefined;
  const out = {error_class: e.name || 'Error', message_redacted: contentSummary(e.message)};
  if (errorCode(e.code)) out.error_code = e.code;
  else if (status) out.error_code = `http_${status}`;
  else if (e.name === 'TimeoutError') out.error_code = 'timeout';
  else if (e.name === 'AbortError') out.error_code = 'aborted';
  if (e.code && !errorCode(e.code)) out.code = contentSummary(e.code);
  if (status) out.status = status;
  if (e.upstream && typeof e.upstream === 'object') out.upstream = Object.fromEntries(
    ['provider','host','status','code','retry_after','request_id','attempts'].filter(k => e.upstream[k] !== undefined).map(k => [k, e.upstream[k]]));
  if (e.cause?.code) out.cause_code = e.cause.code;
  const clean = redact(out);
  if (e.stack) { clean.stack = stackLocations(e.stack); clean.stack_redacted = contentSummary(e.stack); }
  return clean;
}

function threshold() {
  const configured = process.env.FANSCOPE_LOG_LEVEL;
  if (configured && levels[configured]) return levels[configured];
  // Inside `node --test` (inherited by child processes) hide per-request info
  // lines unless a test opts in; lifecycle notices stay visible.
  return process.env.NODE_TEST_CONTEXT ? levels.notice : levels.info;
}

export function logDirectory() {
  if (process.env.FANSCOPE_LOG_DIR) return process.env.FANSCOPE_LOG_DIR;
  if (process.env.NODE_ENV === 'production' && process.env.DATABASE_PATH) return path.join(path.dirname(process.env.DATABASE_PATH), 'logs');
  return null;
}

// warn/error lines are also kept on the data volume so they survive container
// replacement during releases and rollbacks. Daily files, pruned by age.
function writeFile(line, now) {
  const dir = logDirectory();
  if (!dir || Date.now() < fileState.disabledUntil) return;
  try {
    const day = now.slice(0, 10), file = path.join(dir, `fanscope-${day}.jsonl`);
    if (day !== fileState.day) {
      fs.mkdirSync(dir, {recursive: true, mode: 0o700});
      pruneLogFiles(dir, Number(process.env.FANSCOPE_LOG_RETENTION_DAYS) || 14, Date.parse(now));
      fileState.day = day; fileState.capped = false;
    }
    if (fileState.capped) return;
    let size = 0; try { size = fs.statSync(file).size; } catch {}
    if (size >= MAX_FILE_BYTES) {
      fileState.capped = true;
      fs.appendFileSync(file, JSON.stringify({ts: now, level: 'error', event: 'log.file_capped', max_bytes: MAX_FILE_BYTES}) + '\n', {mode: 0o600});
      return;
    }
    fs.appendFileSync(file, line + '\n', {mode: 0o600});
  } catch (error) {
    fileState.disabledUntil = Date.now() + 5 * 60000;
    try { process.stderr.write(JSON.stringify({ts: now, level: 'error', event: 'log.file_unavailable', ...errorFields(error)}) + '\n'); } catch {}
  }
}

export function pruneLogFiles(dir, retentionDays, nowMs = Date.now()) {
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^fanscope-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (m && nowMs - Date.parse(m[1] + 'T00:00:00Z') > retentionDays * 86400000) { fs.rmSync(path.join(dir, name), {force: true}); removed++; }
  }
  return removed;
}

// Never throws: logging must not change request or worker behaviour.
export function log(level, event, fields = {}) {
  try {
    if (!levels[level] || levels[level] < threshold()) return;
    const ts = new Date().toISOString();
    const {request_id: explicitId, ...rest} = fields || {};
    const request_id = explicitId || currentRequestId();
    // Base fields are applied last so caller fields cannot overwrite them.
    const entry = {...redact(rest), ts, level, event, service: 'fanscope-api', commit: /^[0-9a-f]{40}$/.test(process.env.FANSCOPE_COMMIT || '') ? process.env.FANSCOPE_COMMIT : 'unknown'};
    if (request_id) entry.request_id = requestIdFrom(request_id);
    const line = JSON.stringify(entry);
    sink(line);
    // notice (service start/stop) is persisted too, so a failed release leaves a trace.
    if (levels[level] >= levels.notice) writeFile(line, ts);
  } catch {}
}
