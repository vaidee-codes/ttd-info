import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { Inquiry, NewInquiry, InquiryStatus } from "./inquiry-types";

export type { Inquiry, NewInquiry, InquiryStatus } from "./inquiry-types";
export { INQUIRY_STATUSES } from "./inquiry-types";

// Prefer DATA_DIR, then ./data; on serverless hosts (e.g. Vercel) the project
// dir is read-only, so fall back to /tmp. /tmp is ephemeral — attach a real
// database before taking production traffic (see README).
function resolveDataDir(): string {
  const candidates = [
    process.env.DATA_DIR,
    path.join(process.cwd(), "data"),
    path.join("/tmp", "yatra-assist-data"),
  ].filter((d): d is string => Boolean(d));
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // try next candidate
    }
  }
  throw new Error("No writable data directory found for SQLite");
}

const db = new Database(path.join(resolveDataDir(), "yatra-assist.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    temple TEXT NOT NULL,
    tier TEXT NOT NULL,
    preferred_dates TEXT,
    group_size INTEGER NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'new'
  )
`);

export function createInquiry(input: NewInquiry): Inquiry {
  const stmt = db.prepare(`
    INSERT INTO inquiries (created_at, name, email, phone, temple, tier, preferred_dates, group_size, notes, status)
    VALUES (@created_at, @name, @email, @phone, @temple, @tier, @preferred_dates, @group_size, @notes, 'new')
  `);
  const created_at = new Date().toISOString();
  const info = stmt.run({ ...input, created_at });
  return getInquiry(Number(info.lastInsertRowid))!;
}

export function getInquiry(id: number): Inquiry | undefined {
  return db.prepare("SELECT * FROM inquiries WHERE id = ?").get(id) as
    | Inquiry
    | undefined;
}

export function listInquiries(): Inquiry[] {
  return db
    .prepare("SELECT * FROM inquiries ORDER BY created_at DESC")
    .all() as Inquiry[];
}

export function updateInquiryStatus(
  id: number,
  status: InquiryStatus,
): Inquiry | undefined {
  db.prepare("UPDATE inquiries SET status = ? WHERE id = ?").run(status, id);
  return getInquiry(id);
}

export default db;
