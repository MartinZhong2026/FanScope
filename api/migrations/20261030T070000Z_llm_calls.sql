-- K4 (minimal): ledger of every model call made through platform/llm.mjs.
-- Metadata only: never prompts, manuscript text or model output.
CREATE TABLE llm_calls(
 id TEXT PRIMARY KEY,
 idempotency_key TEXT NOT NULL UNIQUE,
 purpose TEXT NOT NULL,
 ref_id TEXT NOT NULL DEFAULT '',
 provider TEXT NOT NULL,
 model TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,
 http_status INTEGER,
 error_code TEXT NOT NULL DEFAULT '',
 finish_reason TEXT NOT NULL DEFAULT '',
 input_tokens INTEGER,
 output_tokens INTEGER,
 cache_hit_tokens INTEGER,
 request_chars INTEGER NOT NULL DEFAULT 0,
 response_chars INTEGER,
 duration_ms INTEGER,
 created_at TEXT NOT NULL,
 finished_at TEXT
);
CREATE INDEX idx_llm_calls_purpose_time ON llm_calls(purpose,created_at);
CREATE INDEX idx_llm_calls_ref ON llm_calls(ref_id);
