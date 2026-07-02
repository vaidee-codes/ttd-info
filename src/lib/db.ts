import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { Inquiry, NewInquiry, InquiryStatus } from "./inquiry-types";

export type { Inquiry, NewInquiry, InquiryStatus } from "./inquiry-types";
export { INQUIRY_STATUSES } from "./inquiry-types";

const dataDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, "yatra-assist.db"));
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
