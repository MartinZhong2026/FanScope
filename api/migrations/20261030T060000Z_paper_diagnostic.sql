-- Paper Diagnostic (D1): private manuscript submissions, explicit shares,
-- mentor-student links and diagnostic runs. Additive only; no existing table
-- is touched. Access rules live in api/src/diagnostic/access.mjs.
CREATE TABLE dx_submissions(
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 title TEXT NOT NULL DEFAULT '',
 filename TEXT NOT NULL,
 mime TEXT NOT NULL,
 size_bytes INTEGER NOT NULL,
 sha256 TEXT NOT NULL,
 file_path TEXT,
 text_content TEXT,
 text_length INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,
 original_expires_at TEXT NOT NULL,
 report_expires_at TEXT NOT NULL,
 consent_version TEXT,
 consent_provider TEXT,
 consented_at TEXT,
 original_purged_at TEXT,
 deleted_at TEXT,
 deleted_by TEXT
);
CREATE INDEX idx_dx_submissions_owner ON dx_submissions(owner_id,created_at);
CREATE INDEX idx_dx_submissions_original_due ON dx_submissions(original_expires_at) WHERE original_purged_at IS NULL;
CREATE TABLE dx_shares(
 submission_id TEXT NOT NULL REFERENCES dx_submissions(id),
 user_id TEXT NOT NULL,
 granted_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(submission_id,user_id)
);
CREATE INDEX idx_dx_shares_user ON dx_shares(user_id);
CREATE TABLE dx_advisor_links(
 mentor_id TEXT NOT NULL,
 student_id TEXT NOT NULL,
 created_by TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(mentor_id,student_id)
);
CREATE INDEX idx_dx_advisor_student ON dx_advisor_links(student_id);
CREATE TABLE dx_runs(
 id TEXT PRIMARY KEY,
 submission_id TEXT NOT NULL REFERENCES dx_submissions(id),
 requested_by TEXT NOT NULL,
 provider TEXT NOT NULL,
 model TEXT NOT NULL DEFAULT '',
 prompt_version TEXT NOT NULL,
 status TEXT NOT NULL,
 structure_json TEXT,
 report_json TEXT,
 error_code TEXT NOT NULL DEFAULT '',
 input_chars INTEGER NOT NULL DEFAULT 0,
 truncated INTEGER NOT NULL DEFAULT 0,
 input_tokens INTEGER,
 output_tokens INTEGER,
 created_at TEXT NOT NULL,
 started_at TEXT,
 heartbeat_at TEXT,
 finished_at TEXT,
 report_purged_at TEXT
);
CREATE INDEX idx_dx_runs_submission ON dx_runs(submission_id,created_at);
