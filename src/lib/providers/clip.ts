/**
 * Cut one ASR window out of the stored audio with ffmpeg so Gemini only hears that window (the whole-file
 * "transcribe only MM:SS–MM:SS" prompt made flash-lite start 40–90s early and duplicate earlier speech).
 *
 * Packaging: ffmpeg-static (postinstall downloads a static linux-x64 binary on Vercel's build, ~75 MB unpacked,
 * traced into the /v1 and /api functions via next.config outputFileTracingIncludes; well under the 250 MB limit
 * together with the Chromium pack). Clips are re-encoded to mono 16 kHz AAC 48 kbps (.m4a, audio/mp4 — same as
 * current uploads): a 3-min window is ~1 MB and cuts in <1s, so it stays far inside maxDuration=300.
 * FFMPEG_PATH overrides the binary; ASR_CLIP=0 disables clipping. Temp files live in os.tmpdir() (/tmp on Vercel)
 * and are always removed.
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import os from "os";
import path from "path";

let cached: string | null | undefined;
export function ffmpegPath(): string | null {
  if (cached !== undefined) return cached;
  const cands: string[] = [];
  if (process.env.FFMPEG_PATH) cands.push(process.env.FFMPEG_PATH);
  try { const p = require("ffmpeg-static") as string | null; if (p) cands.push(p); } catch { /* not installed */ }
  cands.push(path.join(process.cwd(), "node_modules/ffmpeg-static/ffmpeg"), "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg");
  cached = cands.find((p) => { try { return existsSync(p); } catch { return false; } }) ?? null;
  return cached;
}

const run = (bin: string, args: string[]) => new Promise<void>((res, rej) =>
  execFile(bin, args, { timeout: 60_000, maxBuffer: 4 << 20 }, (e, _o, err) => e ? rej(new Error(`ffmpeg failed: ${e.message} ${String(err).slice(-400)}`)) : res()));

/** Holds the source audio in a temp dir; cut() returns clip bytes for [ws,we). Call dispose() in finally. */
export async function clipper(data: Buffer) {
  if (process.env.ASR_CLIP === "0") throw new Error("ASR_CLIP=0");
  const bin = ffmpegPath();
  if (!bin) throw new Error("ffmpeg binary not found");
  const dir = await mkdtemp(path.join(os.tmpdir(), "asr-"));
  const src = path.join(dir, "src");
  await writeFile(src, data);
  let n = 0;
  return {
    /** Clip bytes, or null when the window starts past the end of the audio (ffmpeg emits a header-only file). */
    async cut(ws: number, we: number): Promise<Buffer | null> {
      const out = path.join(dir, `c${n++}.m4a`);
      try {
        await run(bin, ["-hide_banner", "-loglevel", "error", "-ss", String(ws), "-i", src, "-t", String(Math.max(0.5, we - ws)),
          "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "48k", "-y", out]);
        const b = await readFile(out);
        return b.length < 1024 ? null : b;
      } finally { await rm(out, { force: true }); }
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}
