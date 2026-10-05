import fs from "fs";
import Database from "better-sqlite3";
import { databasePath } from "./home.js";

let db;

export function getDb() {
  if (db) return db;
  const file = databasePath();
  fs.mkdirSync(requireDir(file), { recursive: true });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function requireDir(file) {
  const i = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return i > 0 ? file.slice(0, i) : ".";
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT,
      fb_user_id TEXT,
      kind TEXT NOT NULL,
      token_enc TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      page_id TEXT NOT NULL,
      name TEXT,
      category TEXT,
      token_enc TEXT,
      media_folder TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(account_id, page_id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS post_logs (
      id INTEGER PRIMARY KEY,
      job_id TEXT,
      page_row_id INTEGER,
      account_id INTEGER,
      page_id TEXT,
      page_name TEXT,
      post_type TEXT,
      delivery TEXT,
      fb_post_id TEXT,
      post_url TEXT,
      caption TEXT,
      comment_text TEXT,
      comment_id TEXT,
      comment_status TEXT,
      media_path TEXT,
      scheduled_at INTEGER,
      status TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL,
      tasks_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS pick_groups (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      members_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pages_account ON pages(account_id, status);
    CREATE INDEX IF NOT EXISTS idx_logs_media ON post_logs(media_path, status);
    CREATE INDEX IF NOT EXISTS idx_logs_comment ON post_logs(comment_status);
  `);
}

export function getSetting(key, fallback = "") {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  getDb()
    .prepare(
      `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value == null ? "" : String(value));
}

export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
}
