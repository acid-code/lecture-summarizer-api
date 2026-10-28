import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { mkdirSync } from "node:fs";
import * as schema from "./schema";

const url = process.env.DATABASE_URL || "file:./data/local.db";
if (url.startsWith("file:./data")) mkdirSync("./data", { recursive: true });

const client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
export const db = drizzle(client, { schema });

let ready: Promise<void> | null = null;
/** Thin MVP: create tables if missing (use `npm run db:push` for real migrations). */
export function ensureDb() {
  ready ??= (async () => {
    await client.batch([
      `CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, name TEXT NOT NULL, context_pdf_url TEXT, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS lectures (id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id), title TEXT NOT NULL, audio_url TEXT, slides_url TEXT, created_at INTEGER NOT NULL)`,
      `CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, lecture_id TEXT NOT NULL REFERENCES lectures(id), stage TEXT NOT NULL DEFAULT 'queued', error TEXT, artifacts TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL)`,
    ], "write");
  })();
  return ready;
}
export { schema };
