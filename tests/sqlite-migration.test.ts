/**
 * SQLite migration idempotency test.
 *
 * The Hindsight port adds three columns to the `memories` table
 * (fact_type, confidence, entity_ids) and one new table (`observations`).
 * SQLite has no `ADD COLUMN IF NOT EXISTS`, so we introspect via
 * PRAGMA table_info. This test makes sure:
 *
 *   1. New DBs get the columns + observations table.
 *   2. Opening the same DB file a second time does NOT throw "duplicate
 *      column name" — the migration is idempotent.
 *   3. Observations CRUD (upsert/get/delete) round-trip correctly.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SQLiteStorage } from "../src/index.js";

function tmpDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopay-sqlite-mig-"));
  return path.join(dir, "test.db");
}

describe("SQLite Hindsight migration", () => {
  it("creates fact_type / confidence / entity_ids columns on first open", () => {
    const s = new SQLiteStorage(":memory:");
    expect(s.hasColumn("memories", "fact_type")).toBe(true);
    expect(s.hasColumn("memories", "confidence")).toBe(true);
    expect(s.hasColumn("memories", "entity_ids")).toBe(true);
  });

  it("creates the observations table", () => {
    const s = new SQLiteStorage(":memory:");
    // upsert + get should not throw if the table exists.
    s.upsertObservation({
      entityId: "e1",
      summary: "Test summary.",
      factsHash: "abc123",
      updatedAt: 1_000_000,
    });
    const row = s.getObservation("e1");
    expect(row).not.toBeNull();
    expect(row!.summary).toBe("Test summary.");
    expect(row!.factsHash).toBe("abc123");
    expect(row!.updatedAt).toBe(1_000_000);
  });

  it("is idempotent: reopening the same DB file does not throw", () => {
    const dbPath = tmpDbPath();
    // First open — runs the migration.
    const first = new SQLiteStorage(dbPath);
    expect(first.hasColumn("memories", "fact_type")).toBe(true);
    // Second open — migration should no-op, not error.
    expect(() => new SQLiteStorage(dbPath)).not.toThrow();
    const second = new SQLiteStorage(dbPath);
    expect(second.hasColumn("memories", "fact_type")).toBe(true);
    expect(second.hasColumn("memories", "confidence")).toBe(true);
    expect(second.hasColumn("memories", "entity_ids")).toBe(true);
  });

  it("observations CRUD: upsert replaces, delete removes", () => {
    const s = new SQLiteStorage(":memory:");
    s.upsertObservation({ entityId: "x", summary: "v1", factsHash: "h1", updatedAt: 1 });
    s.upsertObservation({ entityId: "x", summary: "v2", factsHash: "h2", updatedAt: 2 });
    const row = s.getObservation("x");
    expect(row!.summary).toBe("v2");
    expect(row!.factsHash).toBe("h2");
    s.deleteObservation("x");
    expect(s.getObservation("x")).toBeNull();
  });

  it("tolerates legacy DBs that pre-date the new columns", () => {
    // Simulate an old DB: create the memories table WITHOUT the new columns,
    // then hand it to SQLiteStorage, which should add the missing columns.
    const dbPath = tmpDbPath();
    // Build a "legacy" schema via better-sqlite3 directly.
    const BetterDb = require("better-sqlite3");
    const legacy = new BetterDb(dbPath);
    legacy.exec(`
      CREATE TABLE agent_state (
        agent_id TEXT PRIMARY KEY,
        wallet REAL NOT NULL DEFAULT 0,
        reputation REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        fraud_guard TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]'
      );
    `);
    legacy.close();

    // Now open via SQLiteStorage — migration should add missing columns.
    const s = new SQLiteStorage(dbPath);
    expect(s.hasColumn("memories", "fact_type")).toBe(true);
    expect(s.hasColumn("memories", "confidence")).toBe(true);
    expect(s.hasColumn("memories", "entity_ids")).toBe(true);
  });
});
