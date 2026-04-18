import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { Chunk, SearchResult } from "./types.js";

let db: Database.Database;

export function initDb(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      session_id TEXT PRIMARY KEY,
      transcript_path TEXT NOT NULL,
      last_indexed_offset INTEGER DEFAULT 0,
      compact_timestamp TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

export function getDb(): Database.Database {
  return db;
}

// --- Session management ---

function sanitizeId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9]/g, "_");
}

function chunksTable(sessionId: string): string {
  return `s_${sanitizeId(sessionId)}_chunks`;
}

function ftsTable(sessionId: string): string {
  return `s_${sanitizeId(sessionId)}_fts`;
}

export function ensureSessionTables(sessionId: string, transcriptPath: string): void {
  const ct = chunksTable(sessionId);
  const ft = ftsTable(sessionId);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ct} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jsonl_offset INTEGER NOT NULL,
      role TEXT NOT NULL,
      message_text TEXT NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding BLOB,
      priority INTEGER DEFAULT 0,
      timestamp TEXT NOT NULL
    )
  `);

  // Idempotent column adds for correction annotation (v1.9.2+)
  try { db.exec(`ALTER TABLE ${ct} ADD COLUMN corrected_at TEXT`); } catch {}
  try { db.exec(`ALTER TABLE ${ct} ADD COLUMN correction_reason TEXT`); } catch {}
  // User-citation behavioral signal (v1.9.3+). Positive-only, capped at 3.0.
  try { db.exec(`ALTER TABLE ${ct} ADD COLUMN user_cite_score REAL DEFAULT 0`); } catch {}
  // LLM downstream usage signal (v1.9.4+, RMM-style). EMA clipped to [-1, 1].
  try { db.exec(`ALTER TABLE ${ct} ADD COLUMN llm_use_score REAL DEFAULT 0`); } catch {}
  // Yi 2014 dwell-time signal (v1.9.7+): ms between this assistant chunk and
  // user's next prompt. NULL = not measured. Ranking normalizes by response length.
  try { db.exec(`ALTER TABLE ${ct} ADD COLUMN dwell_ms INTEGER DEFAULT NULL`); } catch {}

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${ft} USING fts5(
      chunk_text,
      content='${ct}',
      content_rowid='id'
    )
  `);

  // Trigger to keep FTS5 in sync on INSERT
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${ct}_ai AFTER INSERT ON ${ct} BEGIN
      INSERT INTO ${ft}(rowid, chunk_text) VALUES (new.id, new.chunk_text);
    END
  `);

  // Upsert meta
  db.prepare(`
    INSERT INTO meta (session_id, transcript_path)
    VALUES (?, ?)
    ON CONFLICT(session_id) DO UPDATE SET transcript_path = excluded.transcript_path
  `).run(sessionId, transcriptPath);
}

// --- Chunk operations ---

export function insertChunks(sessionId: string, chunks: Chunk[]): void {
  const ct = chunksTable(sessionId);
  const stmt = db.prepare(`
    INSERT INTO ${ct} (jsonl_offset, role, message_text, chunk_text, embedding, priority, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items: Chunk[]) => {
    for (const c of items) {
      stmt.run(c.jsonl_offset, c.role, c.message_text, c.chunk_text, c.embedding, c.priority, c.timestamp);
    }
  });

  insertMany(chunks);
}

export function insertPriorityChunk(sessionId: string, text: string, embedding: Buffer | null, timestamp: string): void {
  const ct = chunksTable(sessionId);
  db.prepare(`
    INSERT INTO ${ct} (jsonl_offset, role, message_text, chunk_text, embedding, priority, timestamp)
    VALUES (-1, 'user', ?, ?, ?, 1, ?)
  `).run(text, text, embedding, timestamp);
}

// --- Search ---

export function searchFTS(
  sessionId: string,
  query: string,
  beforeTimestamp: string,
  limit: number = 20
): SearchResult[] {
  const ct = chunksTable(sessionId);
  const ft = ftsTable(sessionId);

  const rows = db.prepare(`
    SELECT c.id, c.jsonl_offset, c.role, c.message_text, c.chunk_text,
           c.priority, c.timestamp, c.corrected_at, c.correction_reason,
           c.user_cite_score, c.llm_use_score, c.dwell_ms,
           ${ft}.rank AS score
    FROM ${ft}
    JOIN ${ct} c ON c.id = ${ft}.rowid
    WHERE ${ft} MATCH ?
      AND c.timestamp < ?
    ORDER BY c.priority DESC, ${ft}.rank
    LIMIT ?
  `).all(query, beforeTimestamp, limit * 3) as any[];

  // Deduplicate: GROUP BY jsonl_offset, keep best score
  const seen = new Map<number, SearchResult>();
  for (const row of rows) {
    const key = row.jsonl_offset;
    if (!seen.has(key) || row.priority > (seen.get(key)!.priority)) {
      seen.set(key, {
        session_id: sessionId,
        jsonl_offset: row.jsonl_offset,
        role: row.role,
        message_text: row.message_text,
        chunk_text: row.chunk_text,
        score: row.score,
        timestamp: row.timestamp,
        priority: row.priority,
        corrected_at: row.corrected_at ?? null,
        correction_reason: row.correction_reason ?? null,
        user_cite_score: row.user_cite_score ?? 0,
        llm_use_score: row.llm_use_score ?? 0,
        dwell_ms: row.dwell_ms ?? null,
      });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => {
      // Priority first, then score (FTS5 rank is negative, more negative = better)
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.score - b.score;
    })
    .slice(0, limit);
}

export function getAllEmbeddings(
  sessionId: string,
  beforeTimestamp: string,
  minChars: number = 0
): Array<{ id: number; jsonl_offset: number; role: string; message_text: string; chunk_text: string; embedding: Buffer; priority: number; timestamp: string; corrected_at: string | null; correction_reason: string | null; user_cite_score: number; llm_use_score: number; dwell_ms: number | null }> {
  const ct = chunksTable(sessionId);
  return db.prepare(`
    SELECT id, jsonl_offset, role, message_text, chunk_text, embedding, priority, timestamp,
           corrected_at, correction_reason, user_cite_score, llm_use_score, dwell_ms
    FROM ${ct}
    WHERE embedding IS NOT NULL
      AND timestamp < ?
      AND length(chunk_text) >= ?
  `).all(beforeTimestamp, minChars) as any[];
}

// --- Correction annotation ---

export function markLastAssistantCorrected(sessionId: string, reason: string): number {
  const ct = chunksTable(sessionId);
  try {
    const row = db.prepare(`
      SELECT jsonl_offset FROM ${ct}
      WHERE role = 'assistant' AND corrected_at IS NULL
      ORDER BY timestamp DESC LIMIT 1
    `).get() as any;
    if (!row) return 0;
    const res = db.prepare(`
      UPDATE ${ct} SET corrected_at = ?, correction_reason = ?
      WHERE jsonl_offset = ?
    `).run(new Date().toISOString(), reason.slice(0, 200), row.jsonl_offset);
    return Number(res.changes);
  } catch {
    return 0;
  }
}

// EMA-update llm_use_score for a specific chunk based on downstream citation.
// Positive when Claude cited, negative otherwise; clipped to [-1, 1].
export function updateLlmUseScore(sessionId: string, jsonlOffset: number, cited: boolean): void {
  const ct = chunksTable(sessionId);
  try {
    const row = db.prepare(`
      SELECT llm_use_score FROM ${ct} WHERE jsonl_offset = ? LIMIT 1
    `).get(jsonlOffset) as any;
    if (!row) return;
    const old = Number(row.llm_use_score ?? 0);
    const delta = cited ? 1 : -1;
    const next = Math.max(-1, Math.min(1, 0.7 * old + 0.3 * delta));
    db.prepare(`
      UPDATE ${ct} SET llm_use_score = ? WHERE jsonl_offset = ?
    `).run(next, jsonlOffset);
  } catch {}
}

// Yi dwell-time: record ms between the latest assistant chunk's timestamp and
// the user's next prompt. Only fills when NULL to avoid clobbering with AFK gaps
// on later prompts. Cap at 5 min — beyond that we can't distinguish engagement
// from the user walking away.
export function setLastAssistantDwell(sessionId: string, dwellMs: number): void {
  const ct = chunksTable(sessionId);
  const capped = Math.max(0, Math.min(dwellMs, 5 * 60 * 1000));
  try {
    db.prepare(`
      UPDATE ${ct} SET dwell_ms = ?
      WHERE role = 'assistant' AND dwell_ms IS NULL
        AND jsonl_offset = (
          SELECT jsonl_offset FROM ${ct}
          WHERE role = 'assistant' AND dwell_ms IS NULL
          ORDER BY timestamp DESC LIMIT 1
        )
    `).run(capped);
  } catch {}
}

// Increment user_cite_score on the most recent assistant chunk (capped).
// Returns the jsonl_offset that was credited, or null on no-op.
export function incrementLastAssistantUserCite(
  sessionId: string,
  delta: number = 0.5,
  cap: number = 3.0
): number | null {
  const ct = chunksTable(sessionId);
  try {
    const row = db.prepare(`
      SELECT jsonl_offset, user_cite_score FROM ${ct}
      WHERE role = 'assistant'
      ORDER BY timestamp DESC LIMIT 1
    `).get() as any;
    if (!row) return null;
    const newScore = Math.min((row.user_cite_score ?? 0) + delta, cap);
    db.prepare(`
      UPDATE ${ct} SET user_cite_score = ?
      WHERE jsonl_offset = ?
    `).run(newScore, row.jsonl_offset);
    return row.jsonl_offset as number;
  } catch {
    return null;
  }
}

// --- Embedding backfill ---

export function getChunksWithoutEmbedding(
  sessionId: string,
  limit: number
): Array<{ id: number; chunk_text: string }> {
  const ct = chunksTable(sessionId);
  return db.prepare(`
    SELECT id, chunk_text FROM ${ct}
    WHERE embedding IS NULL
    LIMIT ?
  `).all(limit) as any[];
}

export function updateChunkEmbedding(sessionId: string, chunkId: number, embedding: Buffer): void {
  const ct = chunksTable(sessionId);
  db.prepare(`UPDATE ${ct} SET embedding = ? WHERE id = ?`).run(embedding, chunkId);
}

// --- Meta operations ---

export function getLastIndexedOffset(sessionId: string): number {
  const row = db.prepare("SELECT last_indexed_offset FROM meta WHERE session_id = ?").get(sessionId) as any;
  return row?.last_indexed_offset ?? 0;
}

export function setLastIndexedOffset(sessionId: string, offset: number): void {
  db.prepare("UPDATE meta SET last_indexed_offset = ? WHERE session_id = ?").run(offset, sessionId);
}

export function getCompactTimestamp(sessionId: string): string | null {
  const row = db.prepare("SELECT compact_timestamp FROM meta WHERE session_id = ?").get(sessionId) as any;
  return row?.compact_timestamp ?? null;
}

export function setCompactTimestamp(sessionId: string, timestamp: string): void {
  db.prepare("UPDATE meta SET compact_timestamp = ? WHERE session_id = ?").run(timestamp, sessionId);
}

export function getTranscriptPath(sessionId: string): string | null {
  const row = db.prepare("SELECT transcript_path FROM meta WHERE session_id = ?").get(sessionId) as any;
  return row?.transcript_path ?? null;
}

// --- Status ---

export function getEmbeddingProgress(sessionId: string): { total: number; embedded: number } {
  const ct = chunksTable(sessionId);
  try {
    const total = (db.prepare(`SELECT COUNT(*) as c FROM ${ct}`).get() as any)?.c ?? 0;
    const embedded = (db.prepare(`SELECT COUNT(*) as c FROM ${ct} WHERE embedding IS NOT NULL`).get() as any)?.c ?? 0;
    return { total, embedded };
  } catch {
    return { total: 0, embedded: 0 };
  }
}

// --- Session list / delete ---

export function listSessions(): Array<{ session_id: string; transcript_path: string; compact_timestamp: string | null; created_at: string }> {
  return db.prepare("SELECT session_id, transcript_path, compact_timestamp, created_at FROM meta ORDER BY created_at DESC").all() as any[];
}

export function listSessionIds(): string[] {
  return (db.prepare("SELECT session_id FROM meta").all() as any[]).map((r) => r.session_id);
}

export function getSessionStartTime(sessionId: string): string | null {
  const ct = chunksTable(sessionId);
  try {
    const row = db.prepare(`SELECT MIN(timestamp) as ts FROM ${ct}`).get() as any;
    return row?.ts ?? null;
  } catch {
    return null;
  }
}

export function deleteSession(sessionId: string): boolean {
  const ct = chunksTable(sessionId);
  const ft = ftsTable(sessionId);

  try {
    db.exec(`DROP TABLE IF EXISTS ${ft}`);
    db.exec(`DROP TRIGGER IF EXISTS ${ct}_ai`);
    db.exec(`DROP TABLE IF EXISTS ${ct}`);
    db.prepare("DELETE FROM meta WHERE session_id = ?").run(sessionId);
    return true;
  } catch {
    return false;
  }
}
