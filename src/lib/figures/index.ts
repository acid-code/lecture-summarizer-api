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
interface PageInfo { deck: string; page: number; text: string; imageOps: number; score: number; jpeg?: Buffer }

const env = (k: string, d: string) => process.env[k]?.trim() || d;
export const figuresEnabled = () => !/^(0|off|false|no)$/i.test(env("FIGURES", "on"));
const MAX = () => Number(env("FIGURES_MAX", "6"));
const MAX_PAGES = () => Number(env("FIGURES_MAX_PAGES", "24"));
const WIDTH = () => Number(env("FIGURES_WIDTH", "1000"));
export const MISTRAL_MODEL = () => env("MISTRAL_VISION_MODEL", "ministral-14b-2512");
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
/** Section whose citation mentions this slide number, if any. */
function citedSection(s: LectureSummary, page: number): number {
  return s.sections.findIndex((x) => [...`${x.citation ?? ""} ${x.bullets.join(" ")}`.matchAll(/slides?\s*([\d\s,\-–]+)/gi)].some((m) =>
    m[1].split(/[,\s]+/).some((r) => { const [a, b] = r.split(/[-–]/).map(Number); return a && (b ? page >= a && page <= b : page === a); })));
}

async function mistralPick(key: string, s: LectureSummary, cands: PageInfo[], max: number, he: boolean) {
  const sections = s.sections.map((x, i) => `${i}: ${x.heading}`).join("\n");
  const content: unknown[] = [{ type: "text", text:
`You are choosing figures for a lecture study guide. Below are slide images, each preceded by its id.
Pick at most ${max} slides whose GRAPHS, DIAGRAMS, CHARTS, TABLES or PHOTOS genuinely help understanding. Skip title slides, text-only slides, logos and decorative images.
For each pick, choose the best matching study-guide section index from this list:
${sections}
Write a short caption (max 20 words) in ${he ? "Hebrew (English technical terms may stay in English)" : "the summary language"} that describes what the figure shows. Take any numbers ONLY from the image; do not invent values.
Reply with JSON only: {"figures":[{"id":"<id>","section":<index>,"caption":"..."}]}` }];
  for (const c of cands) {
    content.push({ type: "text", text: `id ${c.deck}#${c.page}` });
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
  const out = (JSON.parse(raw).figures ?? []) as { id?: string; section?: number; caption?: string }[];
  return out.flatMap((f) => {
    const c = cands.find((x) => `${x.deck}#${x.page}` === String(f.id).replace(/^id\s*/, ""));
    if (!c) return [];
    const sec = Number.isInteger(f.section) && f.section! >= 0 && f.section! < s.sections.length ? f.section! : matchSection(s, c.text);
    return [{ c, section: sec, caption: String(f.caption ?? "").slice(0, 200) }];
  }).slice(0, max);
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
    // Pre-filter for cost: only pages with images or vector drawings, best-scoring first, capped.
    const cands = all.filter((p) => p.imageOps > 0 || p.score > 0).sort((a, b) => b.score - a.score).slice(0, MAX_PAGES());
    if (!cands.length) { lastFigureNote = `no candidate pages (${all.length} analyzed)`; return []; }
    for (const c of cands) c.jpeg = await renderJpeg(docs.get(c.deck)!, pdfBytes.get(c.deck)!, c.page);
    const he = /[\u0590-\u05FF]/.test(s.overview + s.title);
    let picks: { c: PageInfo; section: number; caption: string }[] | null = null;
    const key = process.env.MISTRAL_API_KEY?.trim();
    if (key) picks = await mistralPick(key, s, cands, max, he).catch((e) => { console.warn("mistral figure pick failed, using heuristic:", (e as Error).message.replace(key, "***")); return null; });
    if (!picks) picks = cands.filter((c) => c.imageOps > 0 && c.text.length < 400).slice(0, Math.min(max, 4)).map((c) => {
      const cited = citedSection(s, c.page);
      return { c, section: cited >= 0 ? cited : matchSection(s, c.text), caption: c.text.slice(0, 120) };
    });
    const multi = decks.length > 1;
    return picks.sort((a, b) => a.c.deck.localeCompare(b.c.deck) || a.c.page - b.c.page)
      .map(({ c, section, caption }) => ({ page: c.page, deck: multi ? c.deck : undefined, caption, section, src: `data:image/jpeg;base64,${c.jpeg!.toString("base64")}` }));
  } catch (e) { lastFigureNote = `failed: ${(e as Error).message}`.slice(0, 300); console.warn("figure extraction failed, text-only PDF:", (e as Error).message); return []; }
}
