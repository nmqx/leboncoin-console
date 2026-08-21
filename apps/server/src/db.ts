import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "./logger.js";

export const MIGRATIONS: Array<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: "init",
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  ciphertext_b64 TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  category TEXT,
  price_cents INTEGER,
  published_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  city TEXT,
  postal_code TEXT,
  department TEXT,
  owner_id TEXT,
  owner_name TEXT,
  owner_type TEXT,
  images_json TEXT NOT NULL DEFAULT '[]',
  attributes_json TEXT NOT NULL DEFAULT '{}',
  score REAL NOT NULL DEFAULT 0,
  deal_score REAL,
  source TEXT NOT NULL,
  raw_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_department ON listings(department);
CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS price_history (
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  price_cents INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (listing_id, observed_at)
);

CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  cadence_minutes INTEGER NOT NULL DEFAULT 10,
  last_run_at TEXT,
  last_status TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS search_jobs (
  id TEXT PRIMARY KEY,
  watch_id INTEGER REFERENCES watches(id) ON DELETE SET NULL,
  spec_json TEXT NOT NULL,
  status TEXT NOT NULL,
  page_count INTEGER,
  items_found INTEGER,
  items_new INTEGER,
  error_code TEXT,
  error_message TEXT,
  error_retryable INTEGER,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  correlation_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_started ON search_jobs(started_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  listing_id TEXT,
  listing_title TEXT,
  listing_price_cents INTEGER,
  other_user TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  unread_count INTEGER NOT NULL DEFAULT 0,
  classification TEXT,
  locked_until TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  sender_id TEXT,
  sender_name TEXT,
  body TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  delivery_status TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, sent_at);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('discord','http')),
  url TEXT NOT NULL,
  secret_cipher TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  events_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON webhook_deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS captured_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  request_headers_json TEXT NOT NULL DEFAULT '{}',
  cookie_names_json TEXT NOT NULL DEFAULT '[]',
  post_data TEXT,
  kind TEXT NOT NULL DEFAULT 'other',
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captured_kind ON captured_requests(kind, captured_at DESC);
`,
  },
  {
    id: 2,
    name: "capture_routing",
    sql: `
-- bases antérieures à la capture : table + colonne HAL + politique de routage
CREATE TABLE IF NOT EXISTS captured_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  request_headers_json TEXT NOT NULL DEFAULT '{}',
  cookie_names_json TEXT NOT NULL DEFAULT '[]',
  post_data TEXT,
  kind TEXT NOT NULL DEFAULT 'other',
  captured_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_captured_kind ON captured_requests(kind, captured_at DESC);

ALTER TABLE conversations ADD COLUMN hal_links_json TEXT;

INSERT OR IGNORE INTO settings (key, value) VALUES ('routing', '{"search":"direct","messaging":"direct"}');
`,
  },
];

export class Db {
  readonly raw: DatabaseSync;

  private constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  }

  static open(file: string): Db {
    return new Db(file);
  }

  static inMemory(): Db {
    const db = new Db(":memory:");
    db.migrate();
    return db;
  }

  migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);"
    );
    const row = this.raw.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    const current = row ? Number(row.value) : 0;
    for (const m of MIGRATIONS) {
      if (m.id <= current) continue;
      this.raw.exec("BEGIN");
      try {
        this.raw.exec(m.sql);
        this.raw
          .prepare(
            "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
          )
          .run(String(m.id));
        this.raw.exec("COMMIT");
        logger.info({ migration: m.name }, "migration appliquée");
      } catch (err) {
        this.raw.exec("ROLLBACK");
        throw err;
      }
    }
  }

  all<T>(sql: string, ...params: Array<string | number | null>): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, ...params: Array<string | number | null>): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Array<string | number | null>): { changes: number | bigint; lastInsertRowid: number | bigint } {
    return this.raw.prepare(sql).run(...params);
  }
}

export function dbFile(dataDir: string): string {
  return join(dataDir, "console.db");
}
