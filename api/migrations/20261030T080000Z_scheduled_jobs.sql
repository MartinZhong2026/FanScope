-- K5: durable schedule. One row per background job. Due times and leases live
-- here so restarts neither lose nor repeat work.
CREATE TABLE scheduled_jobs(
 name TEXT PRIMARY KEY,
 next_due_at TEXT NOT NULL,
 last_started_at TEXT,
 last_finished_at TEXT,
 last_status TEXT NOT NULL DEFAULT '',
 last_error_code TEXT NOT NULL DEFAULT '',
 consecutive_failures INTEGER NOT NULL DEFAULT 0,
 lease_owner TEXT NOT NULL DEFAULT '',
 lease_expires_at TEXT,
 result_json TEXT NOT NULL DEFAULT '{}'
);
