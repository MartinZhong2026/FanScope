# Versioned additive migrations (K3)

This directory is intentionally empty of `.sql` files in K3. With no migration
files, startup and `migrate-cli.mjs` make **no** schema or data change and do
not create the `fanscope_migrations` ledger.

- File name: `<YYYYMMDDTHHMMSSZ>_<lower_snake_name>.sql` (UTC). Order is the
  timestamp; two files may not share one. Any other file here is an error.
- Allowed SQL only: `CREATE TABLE`, `CREATE [UNIQUE] INDEX` (unique only on a
  table created in the same file), `CREATE VIRTUAL TABLE … USING fts5`,
  `ALTER TABLE … ADD COLUMN` (not on tables written with positional `INSERT`,
  see `POSITIONAL_INSERT_TABLES`), and `INSERT INTO <new table>(cols) …`.
- Never edit a file after it has been applied anywhere; add a new migration.
- Startup never applies migrations. They are applied explicitly with
  `npm run migrate -- apply --expect <id>:<sha256>`, and in production only by
  the K2 release controller after backup and frozen-copy rehearsal.

Details and operating procedure: `docs/ops/MIGRATIONS_ZH.md`.
