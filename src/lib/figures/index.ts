/**
 * Figure embedding for the study PDF: render slide pages to JPEG thumbnails, let a cheap vision model
 * (Mistral, `ministral-14b-2512` by default) pick up to FIGURES_MAX important figures {page, caption, section},
 * and return them for render.ts to place inline under the matching summary section.
 *
 *  - PDF: rendered in-process with unpdf + @napi-rs/canvas (works on Vercel, no system binaries).
 *  - PPTX: converted to PDF with LibreOffice (`soffice`) when available; otherwise skipped (text-only).
 *  - Pages are pre-filtered (embedded image ops + little text) and capped (FIGURES_MAX_PAGES) before any API call.
 *  - No MISTRAL_API_KEY or Mistral error → heuristic picks (image-heavy, low-text pages), section matched lexically.
 *  - FIGURES=off disables everything. Never throws: figures are best-effort, the summary always ships.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from "unpdf";
import type { LectureSummary } from "../providers/types";
import { isPptx } from "../pptx";

// pdf.js (unpdf) uses ArrayBuffer#transferToFixedLength (Node >= 21); polyfill for Node 20.
const AB = ArrayBuffer.prototype as unknown as { transferToFixedLength?: (n?: number) => ArrayBuffer };
if (!AB.transferToFixedLength) AB.transferToFixedLength = function (this: ArrayBuffer, n?: number) { return this.slice(0, n ?? this.byteLength); };

export interface Figure {
  /** 1-based page inside its deck. */
  page: number; deck?: string; caption: string;
  /** Index into summary.sections (-1 = no match → rendered after the last section). */
  section: number;
  /** data:image/jpeg;base64,... */
  src: string;
}
export interface SlideDeck { name: string; mime: string; data: Uint8Array }
interface PageInfo { deck: string; page: number; text: string; imageOps: number; score: number; jpeg?: Buffer; sha?: string; dhash?: bigint | null }
interface Pick { c: PageInfo; section: number; caption: string; relevance: number }

const env = (k: string, d: string) => process.env[k]?.trim() || d;
export const figuresEnabled = () => !/^(0|off|false|no)$/i.test(env("FIGURES", "on"));
const MAX = () => Number(env("FIGURES_MAX", "6"));
const MAX_PAGES = () => Number(env("FIGURES_MAX_PAGES", "24"));
/** Max figures under one section (default 1 = only the single best slide per section). */
const PER_SECTION = () => Math.max(1, Number(env("FIGURES_PER_SECTION", "1")));
/** Minimum model relevance (0-10) to keep a pick. */
const MIN_REL = () => Number(env("FIGURES_MIN_RELEVANCE", "6"));
/** dHash hamming distance (of 64) at or below which two slides count as the same image (e.g. PDF + PPTX of one deck, or a repeated slide). */
const DUP_DIST = () => Number(env("FIGURES_DUP_DISTANCE", "6"));
const WIDTH = () => Number(env("FIGURES_WIDTH", "1000"));
export const MISTRAL_MODEL = () => env("MISTRAL_VISION_MODEL", "ministral-14b-2512");
/** Mistral vision rejects requests with more than 8 images ("Total number of images exceeds the maximum allowed of 8"). */
const IMAGES_PER_CALL = () => Math.max(1, Math.min(8, Number(env("MISTRAL_MAX_IMAGES", "8"))));
const CHAT_URL = "https://api.mistral.ai/v1/chat/completions";

const run = promisify(execFile);
/** Load the native canvas via require (dynamic import() breaks under some loaders/bundlers). */
const canvasMod = async (): Promise<typeof import("@napi-rs/canvas")> => {
  // Next/webpack compiles node:module createRequire to undefined on Vercel; @napi-rs/canvas is a serverExternalPackage, so import() stays native there.
  try { const m = await import("@napi-rs/canvas"); return ((m as { default?: unknown }).default ?? m) as typeof import("@napi-rs/canvas"); }
  catch { return createRequire(path.join(process.cwd(), "package.json"))("@napi-rs/canvas") as typeof import("@napi-rs/canvas"); }
};
/** PPTX → PDF via LibreOffice headless. Returns null when soffice is missing (e.g. Vercel). */
export async function pptxToPdf(data: Uint8Array): Promise<Uint8Array | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "pptx-"));
  try {
    const src = path.join(dir, "deck.pptx");
    await writeFile(src, data);
    await run(env("SOFFICE_PATH", "soffice"), ["--headless", "--convert-to", "pdf", "--outdir", dir, src], { timeout: 120_000 });
    return new Uint8Array(await readFile(path.join(dir, "deck.pdf")));
  } catch (e) { console.warn("pptx→pdf unavailable, no figures for this deck:", (e as Error).message); return null; }
  finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

async function toJpeg(png: ArrayBuffer): Promise<Buffer> {
  const { loadImage, createCanvas } = await canvasMod();
  const img = await loadImage(Buffer.from(png));
  const c = createCanvas(img.width, img.height);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, img.width, img.height); g.drawImage(img, 0, 0);
  return c.toBuffer("image/jpeg", 75);
}

/** One page → JPEG ~WIDTH px: poppler `pdftoppm` when installed (fast, robust), else unpdf + @napi-rs/canvas (serverless). */
async function renderJpeg(pdf: Awaited<ReturnType<typeof getDocumentProxy>>, bytes: Uint8Array, page: number): Promise<Buffer> {
  const bin = env("PDFTOPPM_PATH", "pdftoppm");
  const dir = await mkdtemp(path.join(tmpdir(), "pg-"));
  try {
    await writeFile(path.join(dir, "in.pdf"), bytes);
    await run(bin, ["-jpeg", "-jpegopt", "quality=75", "-scale-to-x", String(WIDTH()), "-scale-to-y", "-1", "-f", String(page), "-l", String(page), "-singlefile", "in.pdf", "out"], { cwd: dir, timeout: 60_000 });
    return await readFile(path.join(dir, "out.jpg"));
  } catch {
    const vp = (await pdf.getPage(page)).getViewport({ scale: 1 });
    return toJpeg(await renderPageAsImage(pdf, page, { canvasImport: canvasMod, scale: WIDTH() / vp.width }));
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

/** Text length + count of image paint ops per page (cheap, no rendering). */
async function analyze(deck: string, pdfData: Uint8Array) {
  const pdf = await getDocumentProxy(pdfData.slice());
  const { OPS } = await getResolvedPDFJS();
  const imgOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat].filter((x) => x != null));
  const pages: PageInfo[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const text = ((await page.getTextContent()).items as { str?: string }[]).map((i) => i.str ?? "").join(" ").replace(/\s+/g, " ").trim();
    const ops = await page.getOperatorList();
    const imageOps = ops.fnArray.filter((f) => imgOps.has(f)).length;
    // Many vector paths (charts drawn natively) also count a little.
    const paths = ops.fnArray.filter((f) => f === OPS.constructPath).length;
    const score = (imageOps ? 3 + Math.min(imageOps, 4) : 0) + Math.min(paths / 40, 2) - Math.min(text.length / 300, 3);
    pages.push({ deck, page: p, text, imageOps, score });
  }
  return { pdf, pages };
}

const tokens = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
/** Best section for a page by lexical overlap (heuristic fallback). */
export function matchSection(s: LectureSummary, text: string): number {
  const t = tokens(text);
  let best = -1, bs = 0;
  s.sections.forEach((x, i) => {
    const n = [...tokens(x.heading + " " + x.bullets.join(" "))].filter((w) => t.has(w)).length;
    if (n > bs) { bs = n; best = i; }
  });
  return best;
}
/** Slide numbers cited anywhere in a section (citation + bullets), e.g. "slide 9-12", "slides 14, 15". */
export function sectionSlides(x: LectureSummary["sections"][number]): Set<number> {
  const out = new Set<number>();
  for (const m of `${x.citation ?? ""} ${x.bullets.join(" ")}`.matchAll(/slides?\s*([\d\s,\-–]+)/gi))
    for (const r of m[1].split(/[,\s]+/)) {
      const [a, b] = r.split(/[-–]/).map(Number);
      if (!a) continue;
      if (b && b >= a && b - a < 40) for (let k = a; k <= b; k++) out.add(k); else out.add(a);
    }
  return out;
}
/** Indices of sections that cite this slide number. */
export function citedSections(s: LectureSummary, page: number): number[] {
  return s.sections.flatMap((x, i) => (sectionSlides(x).has(page) ? [i] : []));
}

/** 64-bit difference hash of a JPEG (null if canvas unavailable). */
async function dhash(jpeg: Buffer): Promise<bigint | null> {
  try {
    const { loadImage, createCanvas } = await canvasMod();
    const img = await loadImage(jpeg);
    const c = createCanvas(9, 8); const g = c.getContext("2d");
    g.drawImage(img, 0, 0, 9, 8);
    const d = g.getImageData(0, 0, 9, 8).data;
    const lum = (x: number, y: number) => { const i = (y * 9 + x) * 4; return d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; };
    let h = 0n;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) h = (h << 1n) | (lum(x, y) > lum(x + 1, y) ? 1n : 0n);
    return h;
  } catch { return null; }
}
const hamming = (a: bigint, b: bigint) => { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; };
export function sameImage(a: { sha?: string; dhash?: bigint | null }, b: { sha?: string; dhash?: bigint | null }, dist = DUP_DIST()): boolean {
  if (a.sha && a.sha === b.sha) return true;
  return a.dhash != null && b.dhash != null && hamming(a.dhash, b.dhash) <= dist;
}

/**
 * Final selection: best-first, never the same image twice (exact sha or near-identical dHash), at most PER_SECTION per
 * section, relevance >= MIN_REL, and section snapped to a citing section when the slide is cited elsewhere.
 */
export function finalizePicks<T extends { c: { page: number; sha?: string; dhash?: bigint | null }; section: number; relevance: number }>(
  s: LectureSummary, picks: T[], max: number, perSection = PER_SECTION(), minRel = MIN_REL()): T[] {
  const kept: T[] = []; const per = new Map<number, number>();
  for (const p of [...picks].sort((a, b) => b.relevance - a.relevance)) {
    if (p.relevance < minRel) continue;
    const cited = citedSections(s, p.c.page);
    if (cited.length && !cited.includes(p.section)) p.section = cited.find((i) => (per.get(i) ?? 0) < perSection) ?? cited[0];
    if ((per.get(p.section) ?? 0) >= perSection) continue;
    if (kept.some((k) => k.c === p.c || sameImage(k.c, p.c))) continue;
    kept.push(p); per.set(p.section, (per.get(p.section) ?? 0) + 1);
    if (kept.length >= max) break;
  }
  return kept;
}

async function mistralPick(key: string, s: LectureSummary, cands: PageInfo[], max: number, he: boolean): Promise<Pick[]> {
  const sections = s.sections.map((x, i) => {
    const sl = [...sectionSlides(x)].sort((a, b) => a - b);
    return `${i}: ${x.heading}${sl.length ? ` (cites slides ${sl.join(", ")})` : ""}\n   key points: ${x.bullets.join(" | ").slice(0, 300)}`;
  }).join("\n");
  const content: unknown[] = [{ type: "text", text:
`You are choosing figures for a lecture study guide. Below are slide images, each preceded by its id (deck#slideNumber).
Study-guide sections (index: heading, cited slides, key points):
${sections}

Rules:
- Pick at most ${max} slides, AT MOST ONE per section, each slide at most once, and never two slides that show the same/near-identical content (pick the clearer one).
- Only slides whose GRAPHS, DIAGRAMS, CHARTS, TABLES or annotated PHOTOS directly illustrate that section's key points. Skip title slides, text-only slides, logos, decorative photos and generic images.
- For each section, choose the MOST relevant slide for its topic. Strongly prefer slides the section cites. Do not put a figure in an introductory/overview section unless it illustrates exactly that topic.
- Give relevance 0-10 (10 = the figure explains this section's core concept; below 6 = weak, omit it).
- Caption (max 20 words) in ${he ? "Hebrew (English technical terms may stay in English)" : "the summary language"} describing what the figure shows. Take any numbers ONLY from the image; do not invent values.
Reply with JSON only: {"figures":[{"id":"<id>","section":<index>,"relevance":<0-10>,"caption":"..."}]}` }];
  for (const c of cands) {
    const cited = citedSections(s, c.page);
    content.push({ type: "text", text: `id ${c.deck}#${c.page}${cited.length ? ` (cited by section ${cited.join(", ")})` : ""}` });
    content.push({ type: "image_url", image_url: `data:image/jpeg;base64,${c.jpeg!.toString("base64")}` });
  }
  const r = await fetch(CHAT_URL, {
    method: "POST", signal: AbortSignal.timeout(90_000),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: MISTRAL_MODEL(), temperature: 0.1, response_format: { type: "json_object" }, max_tokens: 1500,
      messages: [{ role: "user", content }] }),
  });
  if (!r.ok) throw new Error(`mistral ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json() as { choices?: { message?: { content?: string } }[] };
  const raw = (j.choices?.[0]?.message?.content ?? "").replace(/^```(?:json)?|```$/gm, "").trim();
  const out = (JSON.parse(raw).figures ?? []) as { id?: string; section?: number; caption?: string; relevance?: number }[];
  return out.flatMap((f) => {
    const c = cands.find((x) => `${x.deck}#${x.page}` === String(f.id).replace(/^id\s*/, ""));
    if (!c) return [];
    const sec = Number.isInteger(f.section) && f.section! >= 0 && f.section! < s.sections.length ? f.section! : matchSection(s, c.text);
    const rel = Number.isFinite(Number(f.relevance)) ? Number(f.relevance) : 6;
    return [{ c, section: sec, caption: String(f.caption ?? "").slice(0, 200), relevance: rel }];
  });
}

/** Main entry: decks (PDF/PPTX bytes) + finished summary → figures to embed. Never throws. */
/** Last reason pickFigures returned nothing / failed (diagnostics, surfaced in artifacts). */
export let lastFigureNote = "";
export async function pickFigures(decks: SlideDeck[], s: LectureSummary): Promise<Figure[]> {
  lastFigureNote = !figuresEnabled() ? "FIGURES=off" : !decks.length ? "no decks" : !s.sections?.length ? "no sections" : "";
  if (lastFigureNote) return [];
  try {
    const all: PageInfo[] = [];
    const pdfBytes = new Map<string, Uint8Array>();
    const docs = new Map<string, Awaited<ReturnType<typeof getDocumentProxy>>>();
    for (const d of decks) {
      const pdfData = isPptx(d.mime, d.name) || d.name.toLowerCase().endsWith(".pptx") ? await pptxToPdf(d.data)
        : d.mime.includes("pdf") || d.name.toLowerCase().endsWith(".pdf") ? d.data : null;
      if (!pdfData) continue;
      const { pdf, pages } = await analyze(d.name, pdfData);
      docs.set(d.name, pdf); pdfBytes.set(d.name, pdfData); all.push(...pages);
    }
    const max = MAX();
    // Pre-filter for cost: pages with images or vector drawings. Slides cited by a section go first (most likely relevant), then best-scoring; capped.
    const visual = all.filter((p) => p.imageOps > 0 || p.score > 0);
    const isCited = (p: PageInfo) => citedSections(s, p.page).length > 0;
    const pool = [...visual.filter(isCited).sort((a, b) => b.score - a.score), ...visual.filter((p) => !isCited(p)).sort((a, b) => b.score - a.score)];
    const cands: PageInfo[] = [];
    for (const c of pool) {
      if (cands.length >= MAX_PAGES()) break;
      c.jpeg = await renderJpeg(docs.get(c.deck)!, pdfBytes.get(c.deck)!, c.page);
      c.sha = createHash("sha1").update(c.jpeg).digest("hex"); c.dhash = await dhash(c.jpeg);
      if (cands.some((k) => sameImage(k, c))) continue; // same slide in PDF+PPTX, or repeated slide: send once
      cands.push(c);
    }
    if (!cands.length) { lastFigureNote = `no candidate pages (${all.length} analyzed)`; return []; }
    const he = /[\u0590-\u05FF]/.test(s.overview + s.title);
    let picks: Pick[] | null = null;
    const key = process.env.MISTRAL_API_KEY?.trim();
    if (key) {
      // Batch candidates (≤8 images per call), run in parallel; finalizePicks ranks all batches together by relevance.
      const n = IMAGES_PER_CALL(), batches: PageInfo[][] = [];
      for (let i = 0; i < cands.length; i += n) batches.push(cands.slice(i, i + n));
      const res = await Promise.allSettled(batches.map((b) => mistralPick(key, s, b, max, he)));
      const ok = res.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      res.forEach((r) => { if (r.status === "rejected") console.warn("mistral figure batch failed:", String((r.reason as Error)?.message).replace(key, "***")); });
      picks = ok.length ? ok.flat() : null;
    }
    if (picks) picks = finalizePicks(s, picks, max);
    else picks = finalizePicks(s, cands.filter((c) => c.imageOps > 0 && c.text.length < 400).map((c) => {
      const cited = citedSections(s, c.page);
      return { c, section: cited.length ? cited[0] : matchSection(s, c.text), caption: c.text.slice(0, 120), relevance: (cited.length ? 8 : 6) + Math.min(c.score, 2) / 10 };
    }), Math.min(max, 4));
    if (!picks.length) lastFigureNote = "no relevant figures";
    const multi = decks.length > 1;
    return picks.sort((a, b) => a.section - b.section || a.c.deck.localeCompare(b.c.deck) || a.c.page - b.c.page)
      .map(({ c, section, caption }) => ({ page: c.page, deck: multi ? c.deck : undefined, caption, section, src: `data:image/jpeg;base64,${c.jpeg!.toString("base64")}` }));
  } catch (e) { lastFigureNote = `failed: ${(e as Error).message}`.slice(0, 300); console.warn("figure extraction failed, text-only PDF:", (e as Error).message); return []; }
}
