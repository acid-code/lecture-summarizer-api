import { ensureDb } from "@/db";
import { createClient } from "@libsql/client";

/**
 * Per-model daily-quota (RPD) cooldowns, persisted in Turso table `model_cooldowns` so they survive cold starts.
 * An in-process cache avoids a DB read per call; the DB is the source of truth (refreshed every 60s).
 */
const cache = new Map<string, number>();
let loadedAt = 0;
let dbClient: ReturnType<typeof createClient> | null = null;
function client() {
  const url = process.env.DATABASE_URL?.trim() || "file:./data/local.db";
  dbClient ??= createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
  return dbClient;
}

/** RPD/daily quota signal (vs. per-minute RPM which is retried on the same model). */
export function isDailyQuota(msg: string): boolean {
  if (/PerDay|per[ _-]?day|daily|RPD/i.test(msg)) return true;
  const s = retryDelaySec(msg);
  return s !== null && s >= 3600;
}
export const isQuotaError = (m: string) => /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(m);
/** Parse Google's retryDelay ("37s") or "retry in 12.3s / 5h" hints. */
export function retryDelaySec(msg: string): number | null {
  const a = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (a) return Number(a[1]);
  const b = msg.match(/retry in (\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/i);
  if (!b) return null;
  const n = Number(b[1]);
  return b[2] === "ms" ? n / 1000 : b[2] === "m" ? n * 60 : b[2] === "h" ? n * 3600 : n;
}
export function nextUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

async function load(force = false) {
  if (!force && Date.now() - loadedAt < 60_000) return;
  try {
    await ensureDb();
    const r = await client().execute({ sql: "SELECT model, exhausted_until FROM model_cooldowns WHERE exhausted_until > ?", args: [Date.now()] });
    for (const row of r.rows) cache.set(String(row.model), Math.max(cache.get(String(row.model)) ?? 0, Number(row.exhausted_until)));
    loadedAt = Date.now();
  } catch (e) { console.warn(`quota cooldown load failed (using in-memory only): ${(e as Error).message}`); }
}

/** Models from `ladder` not currently marked RPD-exhausted (order preserved). */
export async function availableModels(ladder: string[]): Promise<{ available: string[]; skipped: { model: string; until: number }[] }> {
  await load();
  const now = Date.now();
  const skipped = ladder.filter((m) => (cache.get(m) ?? 0) > now).map((m) => ({ model: m, until: cache.get(m)! }));
  for (const s of skipped) console.warn(`gemini skip ${s.model}: daily quota (RPD) exhausted until ${new Date(s.until).toISOString()}`);
  return { available: ladder.filter((m) => (cache.get(m) ?? 0) <= now), skipped };
}

export async function markExhausted(model: string, msg: string) {
  const delay = retryDelaySec(msg);
  const until = Math.max(nextUtcMidnight(), delay ? Date.now() + delay * 1000 : 0);
  cache.set(model, until);
  console.warn(`gemini ${model}: daily quota (RPD) exhausted → skipping until ${new Date(until).toISOString()}`);
  try {
    await ensureDb();
    await client().execute({
      sql: `INSERT INTO model_cooldowns (model, exhausted_until, reason, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(model) DO UPDATE SET exhausted_until = MAX(exhausted_until, excluded.exhausted_until), reason = excluded.reason, updated_at = excluded.updated_at`,
      args: [model, until, msg.slice(0, 500), Date.now()],
    });
  } catch (e) { console.warn(`quota cooldown persist failed: ${(e as Error).message}`); }
}

export async function cooldowns() {
  await load(true);
  const now = Date.now();
  return [...cache].filter(([, u]) => u > now).map(([model, u]) => ({ model, exhausted_until: new Date(u).toISOString() }));
}
