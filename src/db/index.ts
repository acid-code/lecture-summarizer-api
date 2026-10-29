import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import * as schema from "./schema";

type DB = LibSQLDatabase<typeof schema>;
let client: Client | null = null;
let _db: DB | null = null;

function init(): { client: Client; db: DB } {
  if (client && _db) return { client, db: _db };
  const envUrl = process.env.DATABASE_URL?.trim();
  if (process.env.VERCEL && (!envUrl || envUrl.startsWith("file:"))) {
    throw new Error(
      "Database not configured: on Vercel the filesystem is read-only, so a local file DB cannot be used. " +
        "Set DATABASE_URL (libsql://… from Turso) and DATABASE_AUTH_TOKEN in Vercel → Project → Settings → Environment Variables, then redeploy.",
    );
  }
  const url = envUrl || "file:./data/local.db";
  if (url.startsWith("file:./data")) mkdirSync("./data", { recursive: true });
  client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
  _db = drizzle(client, { schema });
  return { client, db: _db };
}

/** Lazily initialized: nothing connects or touches the filesystem until first use. */
export const db: DB = new Proxy({} as DB, {
  get(_t, prop) {
    const real = init().db as unknown as Record<string | symbol, unknown>;
    const v = real[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
  },
});

let ready: Promise<void> | null = null;
/** Thin MVP (no migrations; delete data/local.db after schema changes): create tables if missing (use `npm run db:push` for real migrations). */
export function ensureDb() {
  ready ??= (async () => {
    const { client } = init();
    await client.batch([
      `CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, name TEXT NOT NULL, lang_primary TEXT NOT NULL DEFAULT 'he', context_pdf_url TEXT, context_text TEXT, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS lectures (id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id), title TEXT NOT NULL, recorded_at TEXT, audio_url TEXT, slides_url TEXT, slides_text TEXT, markers TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, lecture_id TEXT NOT NULL REFERENCES lectures(id), seq INTEGER NOT NULL, started_at TEXT, duration REAL, url TEXT, mime TEXT NOT NULL DEFAULT 'audio/mp4', created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, lecture_id TEXT NOT NULL REFERENCES lectures(id), stage TEXT NOT NULL DEFAULT 'queued', error TEXT, artifacts TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS lecture_files (id TEXT PRIMARY KEY, lecture_id TEXT NOT NULL REFERENCES lectures(id), kind TEXT NOT NULL DEFAULT 'slides', name TEXT NOT NULL, mime TEXT NOT NULL, url TEXT NOT NULL, text TEXT, size INTEGER, created_at INTEGER NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS lecture_files_lecture ON lecture_files(lecture_id)`,
    ], "write");
  })();
  ready.catch(() => { ready = null; });
  return ready;
}
export { schema };
