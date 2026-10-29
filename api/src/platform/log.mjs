// Structured JSON-lines logging with request correlation and redaction.
// Dependency-free on purpose: entry points such as v14-server.mjs clear
// credentials from process.env before config.mjs is imported, so this module
// must not import config.mjs. It never touches the database (the release
// controller treats any startup database write as a failed deployment).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';

const context = new AsyncLocalStorage();
// notice = normal but significant (service lifecycle); always shown at the default threshold.
const levels = {debug: 10, info: 20, notice: 25, warn: 30, error: 40};
// Key names are normalised to lower_snake before matching, so "X-Admin-Key"
// and "apiKey" are both caught while counters such as input_tokens are not.
const SENSITIVE_KEY = /(^|_)(pass|password|passwd|secret|token|api_?key|authorization|cookie|credential|admin_?key|session)$/;
// Free-text research content is replaced by its length and a short hash.
const CONTENT_KEY = /^(body|text|content|prompt|messages|abstract|manuscript|transcript|html|raw|response|completion|quote|source_quote|note|summary|chat|comment|reply|answer|question|query|q|evidence)$/;
// Exception messages can embed input (V8 JSON errors quote the text, providers echo
// bodies). Only short plain diagnostics or explicitly safe messages are kept verbatim.
const SAFE_MESSAGE = /^[A-Za-z0-9 _.,:;()\/+#%=-]{1,160}$/;
const UPSTREAM_KEYS = ['provider', 'host', 'status', 'retry_after', 'request_id', 'attempts'];
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
  return /^[A-Za-z0-9._:-]{8,80}$/.test(v) ? v : crypto.randomUUID();
}

// Collapse identifiers so access logs group by route, not by record.
export function routeTemplate(pathname) {
  return String(pathname || '/').split('/').map(part =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part) || /^[0-9a-f]{16,}$/i.test(part) ||
    /^\d+$/.test(part) || /^(doi|cn|feed|manual):/i.test(part) ? ':id' : part.slice(0, 60)).join('/').slice(0, 200);
}

export function redactString(value, max = 300) {
  let v = String(value);
  v = v.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/([?&](?:api_key|apikey|key|token|access_token|signature|mailto)=)[^&\s#"]*/gi, '$1[REDACTED]')
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');
  return v.length > max ? v.slice(0, max) + '…[truncated]' : v;
}

const contentSummary = v => ({redacted: 'content', length: String(v).length,
  sha256: crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 12)});
const normaliseKey = k => String(k).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^A-Za-z0-9]+/g, '_').toLowerCase();

export function redact(value, depth = 0) {
  if (value === null || value === undefined || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Error) return errorFields(value);
  if (depth >= 4) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 20).map(v => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
      const key = normaliseKey(k);
      if (SENSITIVE_KEY.test(key)) out[k] = '[REDACTED]';
      else if (CONTENT_KEY.test(key) && typeof v === 'string') out[k] = contentSummary(v);
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return redactString(String(value));
}

export function errorFields(error) {
  const e = error instanceof Error ? error : Object.assign(new Error(String(error)), {name: 'NonError'});
  const message = String(e.message || '');
  const out = {error_class: e.name || 'Error'};
  if (e.safeMessage === true || SAFE_MESSAGE.test(message)) out.message = redactString(message, 160);
  else out.message_redacted = {length: message.length, sha256: crypto.createHash('sha256').update(message).digest('hex').slice(0, 12)};
  if (typeof e.code === 'string' && e.code.length <= 60) out.error_code = e.code;
  else if (Number.isInteger(e.status)) out.error_code = `http_${e.status}`;
  else if (e.name === 'TimeoutError') out.error_code = 'timeout';
  else if (e.name === 'AbortError') out.error_code = 'aborted';
  if (Number.isInteger(e.status)) out.status = e.status;
  if (e.upstream && typeof e.upstream === 'object') out.upstream = redact(Object.fromEntries(UPSTREAM_KEYS.filter(k => e.upstream[k] !== undefined).map(k => [k, e.upstream[k]])));
  if (e.cause?.code && typeof e.cause.code === 'string') out.cause_code = e.cause.code.slice(0, 60);
  if (e.stack) out.stack = String(e.stack).split('\n').filter(l => /^\s+at /.test(l)).slice(0, 6).map(l => redactString(l.trim(), 200));
  return out;
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
    const entry = {...redact(rest), ts, level, event, service: 'fanscope-api', commit: process.env.FANSCOPE_COMMIT || 'unknown'};
    if (request_id) entry.request_id = requestIdFrom(request_id);
    const line = JSON.stringify(entry);
    sink(line);
    // notice (service start/stop) is persisted too, so a failed release leaves a trace.
    if (levels[level] >= levels.notice) writeFile(line, ts);
  } catch {}
}
