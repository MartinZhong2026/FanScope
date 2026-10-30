// SQLite ledger for platform/llm.mjs (table from migration *_llm_calls.sql).
import {db} from '../db.mjs';
const FIELDS=['status','attempts','http_status','error_code','finish_reason','input_tokens','output_tokens','cache_hit_tokens','response_chars','duration_ms','finished_at'];
export function dbLedger(){
 return {
  reserve(row){
   const r=db.prepare(`INSERT OR IGNORE INTO llm_calls(id,idempotency_key,purpose,ref_id,provider,model,status,request_chars,created_at) VALUES(?,?,?,?,?,?,'reserved',?,?)`)
    .run(row.id,row.idempotency_key,row.purpose,row.ref_id,row.provider,row.model||'',row.request_chars,row.created_at);
   return r.changes===1;
  },
  finish(key,fields){
   const keys=FIELDS.filter(k=>fields[k]!==undefined);
   db.prepare(`UPDATE llm_calls SET ${keys.map(k=>k+'=?').join(',')} WHERE idempotency_key=?`).run(...keys.map(k=>fields[k]),key);
  }};
}
