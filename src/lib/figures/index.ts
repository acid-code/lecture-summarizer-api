import { pageInRange, type SlideRange } from "../slide-ranges";
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
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { getDocumentProxy, getResolvedPDFJS, renderPageAsImage } from "unpdf";
import type { LectureSummary } from "../providers/types";
import { SLIDES_PAGE_CAP } from "../providers/types";
import { isPptx, pptxSlides } from "../pptx";
import { unzipSync } from "fflate";

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
export interface SlideDeck { name: string; mime: string; data: Uint8Array; range?:SlideRange|null }
interface PageInfo { deck: string; page: number; text: string; imageOps: number; score: number; jpeg?: Buffer; sha?: string; dhash?: bigint | null }
interface Pick { c: PageInfo; section: number; caption: string; relevance: number }

const env = (k: string, d: string) => process.env[k]?.trim() || d;
export const figuresEnabled = () => !/^(0|off|false|no)$/i.test(env("FIGURES", "on"));
const MAX = () => Number(env("FIGURES_MAX", "6"));
const MAX_PAGES = () => Number(env("FIGURES_MAX_PAGES", "24"));
/** Max figures under one section (default 1 = only the single best slide per section). */
const PER_SECTION = () => Math.max(1, Number(env("FIGURES_PER_SECTION", "1")));
/** Minimum model relevance (0-10) to keep a pick. */
const MIN_REL = () => Number(env("FIGURES_MIN_RELEVANCE", "7"));
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

let hebrewFontReady = false;
/** Register IBM Plex Sans Hebrew so OOXML text on text-only slides isn't tofu boxes. */
async function ensureHebrewFont() {
  if (hebrewFontReady) return;
  const fontPath = path.join(process.cwd(), "fonts", "IBMPlexSansHebrew-Regular.ttf");
  if (!existsSync(fontPath)) return;
  try {
    // Prefer the same module instance createCanvas uses (dynamic import vs createRequire can diverge).
    const mod = await canvasMod();
    mod.GlobalFonts.registerFromPath(fontPath, "IBM Plex Sans Hebrew");
    hebrewFontReady = true;
  } catch (e) {
    try {
      const req = createRequire(path.join(process.cwd(), "package.json"));
      (req("@napi-rs/canvas") as typeof import("@napi-rs/canvas")).GlobalFonts.registerFromPath(fontPath, "IBM Plex Sans Hebrew");
      hebrewFontReady = true;
    } catch { console.warn("hebrew font register failed:", (e as Error).message); }
  }
}
const HEB_FONT = "IBM Plex Sans Hebrew";
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

async function toJpeg(png: ArrayBuffer, quality = 75): Promise<Buffer> {
  const { loadImage, createCanvas } = await canvasMod();
  const img = await loadImage(Buffer.from(png));
  const c = createCanvas(img.width, img.height);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, img.width, img.height); g.drawImage(img, 0, 0);
  return c.toBuffer("image/jpeg", quality);
}

/**
 * Crop near-white margins, keep natural aspect ratio (no forced 16:9 zoom).
 * Turns "tiny photo in a huge white slide" into a frame-filling figure.
 */
async function trimWhitespace(jpeg: Buffer, quality = 82, pad = 0.04): Promise<Buffer | null> {
  const { loadImage, createCanvas } = await canvasMod();
  const img = await loadImage(jpeg);
  const src = createCanvas(img.width, img.height);
  const sg = src.getContext("2d");
  sg.drawImage(img, 0, 0);
  const { data, width: W, height: H } = sg.getImageData(0, 0, img.width, img.height);
  let minX = W, minY = H, maxX = 0, maxY = 0, ink = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      // Treat near-white + near-transparent junk as empty; keep light-gray chrome.
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) {
        ink++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (ink < W * H * 0.008 || maxX < minX || maxY < minY) return null;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  // Already fills most of the slide — trimming won't help.
  if (bw * bh > W * H * 0.82) return jpeg;
  const px = Math.round(Math.max(bw, bh) * pad);
  const sx = Math.max(0, minX - px), sy = Math.max(0, minY - px);
  const sw = Math.min(W - sx, bw + 2 * px), sh = Math.min(H - sy, bh + 2 * px);
  const out = createCanvas(sw, sh);
  const og = out.getContext("2d");
  og.fillStyle = "#fff";
  og.fillRect(0, 0, sw, sh);
  og.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toBuffer("image/jpeg", quality);
}

/**
 * Crop near-white margins and letterbox onto a fixed canvas so slide thumbs sit centered
 * (broken PPTX composites often leave content shoved into one corner).
 * Returns null when the frame is essentially blank.
 */
async function autocropCenter(jpeg: Buffer, outW: number, outH: number, quality = 82): Promise<Buffer | null> {
  const { loadImage, createCanvas } = await canvasMod();
  const img = await loadImage(jpeg);
  const src = createCanvas(img.width, img.height);
  const sg = src.getContext("2d");
  sg.drawImage(img, 0, 0);
  const { data, width: W, height: H } = sg.getImageData(0, 0, img.width, img.height);
  let minX = W, minY = H, maxX = 0, maxY = 0, ink = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (data[i] < 248 || data[i + 1] < 248 || data[i + 2] < 248) {
        ink++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (ink < W * H * 0.012 || maxX < minX || maxY < minY) return null;
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const out = createCanvas(outW, outH);
  const og = out.getContext("2d");
  og.fillStyle = "#fff";
  og.fillRect(0, 0, outW, outH);
  const sc = Math.min(outW / bw, outH / bh) * 0.96;
  const dw = bw * sc, dh = bh * sc;
  og.drawImage(img, minX, minY, bw, bh, (outW - dw) / 2, (outH - dh) / 2, dw, dh);
  return out.toBuffer("image/jpeg", quality);
}

/** One page → JPEG ~WIDTH px: poppler `pdftoppm` when installed (fast, robust), else unpdf + @napi-rs/canvas (serverless). */
async function renderJpeg(
  pdf: Awaited<ReturnType<typeof getDocumentProxy>>,
  bytes: Uint8Array,
  page: number,
  opts: { width?: number; quality?: number } = {},
): Promise<Buffer> {
  const w = opts.width ?? WIDTH();
  const q = opts.quality ?? 75;
  const bin = env("PDFTOPPM_PATH", "pdftoppm");
  const dir = await mkdtemp(path.join(tmpdir(), "pg-"));
  try {
    await writeFile(path.join(dir, "in.pdf"), bytes);
    await run(bin, ["-jpeg", "-jpegopt", `quality=${q}`, "-scale-to-x", String(w), "-scale-to-y", "-1", "-f", String(page), "-l", String(page), "-singlefile", "in.pdf", "out"], { cwd: dir, timeout: 60_000 });
    return await readFile(path.join(dir, "out.jpg"));
  } catch {
    const vp = (await pdf.getPage(page)).getViewport({ scale: 1 });
    return toJpeg(await renderPageAsImage(pdf, page, { canvasImport: canvasMod, scale: w / vp.width }), q);
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
const TITLE_RE = /\b(lecture|lesson|class|week|chapter)\s*\d+|\b(introduction|agenda|outline|overview|contents|thank you|questions\?)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\b(prof\.?|professor|dr\.)\s|הרצאה\s*\d+|שיעור\s*\d+|מבוא|תוכן עניינים|סדר היום|מרצה/i;
/** Cover / title / agenda slides never become figures (models ignore "skip title slides"). */
export function isTitleSlide(p: { page: number; text: string; imageOps: number }): boolean {
  const t = p.text.replace(/\s+/g, " ").trim();
  if (p.page === 1) return true; // deck cover
  if (p.page <= 3 && (t.length < 220 || TITLE_RE.test(t)) && p.imageOps <= 1) return true;
  if (TITLE_RE.test(t) && t.length < 160 && p.imageOps === 0) return true;
  return false;
}
export let lastFigureNote = "";
/** Heuristic (no-vision) picks score 6-6.2 when uncited; the vision threshold (7) silently dropped all of them. */
const HEURISTIC_MIN_REL = 6;
/** MISTRAL_API_KEY (also accepts the misspelled MISTRAL_API_KRY that production was configured with). */
export const mistralKey = () => (process.env.MISTRAL_API_KEY || process.env.MISTRAL_API_KRY || "").trim() || undefined;

/** EMU box on the slide (after group transforms). */
type EmuBox = { x: number; y: number; cx: number; cy: number };
type GrpXfrm = EmuBox & { chX: number; chY: number; chCx: number; chCy: number };

function parseEmuXfrm(block: string): { box: EmuBox; ch?: GrpXfrm } | null {
  const xfrm = block.match(/<a:xfrm\b[\s\S]*?<\/a:xfrm>/)?.[0];
  if (!xfrm) return null;
  const num = (tag: string, attr: string) => Number(xfrm.match(new RegExp(`<a:${tag}\\b[^>]*\\b${attr}="(-?\\d+)"`))?.[1] || 0);
  const box = { x: num("off", "x"), y: num("off", "y"), cx: num("ext", "cx"), cy: num("ext", "cy") };
  const chX = num("chOff", "x"), chY = num("chOff", "y"), chCx = num("chExt", "cx"), chCy = num("chExt", "cy");
  return { box, ch: chCx > 0 && chCy > 0 ? { ...box, chX, chY, chCx, chCy } : undefined };
}

/** Map a child box from a group's child-space into parent/slide EMUs. */
function mapThruGroup(grp: GrpXfrm, child: EmuBox): EmuBox {
  const sx = grp.chCx ? grp.cx / grp.chCx : 1;
  const sy = grp.chCy ? grp.cy / grp.chCy : 1;
  return {
    x: grp.x + (child.x - grp.chX) * sx,
    y: grp.y + (child.y - grp.chY) * sy,
    cx: child.cx * sx,
    cy: child.cy * sy,
  };
}

/**
 * Every <p:pic> with an absolute EMU box, honoring nested <p:grpSp> transforms.
 * Without this, grouped pictures keep child-space coords and pile up in one corner.
 */
export function pptxAbsolutePics(slideXml: string): { pic: string; box: EmuBox }[] {
  const out: { pic: string; box: EmuBox }[] = [];
  const walk = (xml: string, ancestors: GrpXfrm[]) => {
    let i = 0;
    while (i < xml.length) {
      const rest = xml.slice(i);
      const grpOpen = rest.search(/<p:grpSp\b/);
      const picOpen = rest.search(/<p:pic\b/);
      if (grpOpen < 0 && picOpen < 0) break;
      const takeGrp = grpOpen >= 0 && (picOpen < 0 || grpOpen < picOpen);
      if (takeGrp) {
        const start = i + grpOpen;
        const openEnd = xml.indexOf(">", start) + 1;
        let depth = 1, j = openEnd;
        while (j < xml.length && depth > 0) {
          const nextOpen = xml.slice(j).search(/<p:grpSp\b/);
          const nextClose = xml.slice(j).search(/<\/p:grpSp>/);
          if (nextClose < 0) break;
          if (nextOpen >= 0 && nextOpen < nextClose) { depth++; j += nextOpen + 8; }
          else {
            j += nextClose;
            depth--;
            if (depth === 0) { j += "</p:grpSp>".length; break; }
            j += "</p:grpSp>".length;
          }
        }
        const full = xml.slice(start, j);
        const inner = full.slice(full.indexOf(">") + 1, full.lastIndexOf("</p:grpSp>"));
        const pr = full.match(/<p:grpSpPr\b[\s\S]*?<\/p:grpSpPr>/)?.[0] ?? "";
        const parsed = parseEmuXfrm(pr);
        let next = ancestors;
        if (parsed?.ch) {
          // ancestors are innermost-first; map this group's box up, then push it as the new innermost.
          const abs = ancestors.reduce((box, g) => mapThruGroup(g, box), parsed.box);
          next = [{ ...parsed.ch, ...abs }, ...ancestors];
        }
        walk(inner, next);
        i = j;
        continue;
      }
      const start = i + picOpen;
      const end = xml.indexOf("</p:pic>", start);
      if (end < 0) break;
      const pic = xml.slice(start, end + "</p:pic>".length);
      const spPr = pic.match(/<p:spPr\b[\s\S]*?<\/p:spPr>/)?.[0] ?? pic;
      const parsed = parseEmuXfrm(spPr);
      if (parsed) {
        const box = ancestors.reduce((b, g) => mapThruGroup(g, b), parsed.box);
        if (box.cx > 0 && box.cy > 0) out.push({ pic, box });
      }
      i = end + "</p:pic>".length;
    }
  };
  const tree = slideXml.match(/<p:spTree\b[\s\S]*<\/p:spTree>/)?.[0] ?? slideXml;
  walk(tree, []);
  return out;
}

/**
 * PPTX without LibreOffice: composite each slide onto a white canvas using positioned pictures
 * from OOXML (not "largest media only", which produced tiny portraits + missing slide chrome).
 */
export async function pptxMediaPages(deck: string, data: Uint8Array, only?: (page: number) => boolean): Promise<PageInfo[]> {
  try {
    const texts = pptxSlides(data);
    const files = unzipSync(data, { filter: (f) =>
      /^ppt\/(slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|_rels\/presentation\.xml\.rels|presentation\.xml|media\/[^/]+\.(png|jpe?g))$/i.test(f.name) });
    const str = (n: string) => (files[n] ? new TextDecoder().decode(files[n]) : "");
    const bin = (n: string) => files[n];
    const rels = Object.fromEntries([...str("ppt/_rels/presentation.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [m[0].match(/Id="([^"]+)"/)?.[1], m[0].match(/Target="([^"]+)"/)?.[1]]));
    let order = [...str("ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*r:id="([^"]+)"/g)].map((m) => rels[m[1]]).filter(Boolean)
      .map((t) => {
        const s = String(t).replace(/^\/?/, "");
        return s.startsWith("ppt/") ? s : `ppt/${s}`;
      });
    if (!order.length) {
      order = Object.keys(files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/i.test(f))
        .sort((a, b) => +a.match(/(\d+)\.xml/i)![1] - +b.match(/(\d+)\.xml/i)![1]);
    }
    const sizeM = str("ppt/presentation.xml").match(/<p:sldSz\b[^>]*>/);
    const cx = Number(sizeM?.[0].match(/\bcx="(\d+)"/)?.[1] || 12192000);
    const cy = Number(sizeM?.[0].match(/\bcy="(\d+)"/)?.[1] || 6858000);
    const W = Math.max(WIDTH(), 1400);
    const H = Math.max(720, Math.round(W * cy / cx));
    const { loadImage, createCanvas } = await canvasMod();
    const out: PageInfo[] = [];
    for (let i = 0; i < order.length; i++) {
      if (only && !only(i + 1)) continue;
      const slidePath = order[i].endsWith(".xml") ? order[i] : `ppt/slides/${order[i]}`;
      const slideXml = str(slidePath);
      const relName = slidePath.replace(/^ppt\/slides\//, "").replace(/\.xml$/i, "");
      const relXml = str(`ppt/slides/_rels/${relName}.xml.rels`) || str(`ppt/slides/_rels/${relName}.rels`);
      const embed = Object.fromEntries([...relXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
        m[0].match(/Id="([^"]+)"/)?.[1],
        m[0].match(/Target="([^"]+)"/)?.[1],
      ]).filter((x) => x[0] && x[1]) as [string, string][]);
      const c = createCanvas(W, H);
      const g = c.getContext("2d");
      g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
      let imageOps = 0;
      for (const { pic, box } of pptxAbsolutePics(slideXml)) {
        const id = pic.match(/r:embed="([^"]+)"/)?.[1];
        const target = id ? embed[id] : null;
        if (!target) continue;
        const mediaPath = (() => {
          const cleaned = String(target).replace(/\\/g, "/").replace(/^\//, "");
          if (cleaned.startsWith("ppt/")) return cleaned;
          if (cleaned.startsWith("../")) return `ppt/${cleaned.replace(/^\.\.\//, "")}`;
          if (cleaned.startsWith("media/")) return `ppt/${cleaned}`;
          return `ppt/media/${cleaned.split("/").pop()}`;
        })();
        const bytes = bin(mediaPath);
        if (!bytes || bytes.length < 64) continue;
        try {
          const img = await loadImage(Buffer.from(bytes));
          const left = (box.x / cx) * W, top = (box.y / cy) * H;
          const rw = Math.max(1, (box.cx / cx) * W), rh = Math.max(1, (box.cy / cy) * H);
          // Optional OOXML crop (srcRect attrs are 1000ths of a percent → 0..1).
          const src = pic.match(/<a:srcRect\b[^>]*\/?>/)?.[0];
          const pct = (attr: string) => Math.min(1, Math.max(0, Number(src?.match(new RegExp(`\\b${attr}="(-?\\d+)"`))?.[1] || 0) / 100_000));
          const sl = pct("l"), st = pct("t"), sr = pct("r"), sb = pct("b");
          const sx = Math.round(sl * img.width), sy = Math.round(st * img.height);
          const sw = Math.max(1, Math.round(img.width * (1 - sl - sr)));
          const sh = Math.max(1, Math.round(img.height * (1 - st - sb)));
          // Stretch into the picture frame (PowerPoint default) so multi-photo grids stay tiled.
          g.drawImage(img, sx, sy, sw, sh, left, top, rw, rh);
          imageOps++;
        } catch { /* skip bad image */ }
      }
      const resolveMedia = (target: string) => {
        const cleaned = String(target).replace(/\\/g, "/").replace(/^\//, "");
        if (cleaned.startsWith("ppt/")) return cleaned;
        if (cleaned.startsWith("../")) return `ppt/${cleaned.replace(/^\.\.\//, "")}`;
        if (cleaned.startsWith("media/")) return `ppt/${cleaned}`;
        return `ppt/media/${cleaned.split("/").pop()}`;
      };
      if (!imageOps) {
        // Fallback: largest raster on the slide, letterboxed (better than empty).
        const media = Object.values(embed).map((t) => bin(resolveMedia(t)))
          .filter((b) => !!b && b.length >= 8_000)
          .sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))[0];
        if (media) {
          try {
            const img = await loadImage(Buffer.from(media));
            const sc = Math.min(W / img.width, H / img.height);
            const dw = img.width * sc, dh = img.height * sc;
            g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
            imageOps = 1;
          } catch { /* skip */ }
        }
      }
      const text = (texts[i]?.text ?? "").replace(/\s+/g, " ").trim();
      // Skip OOXML text paint when rasters exist — notes column already explains; avoids tofu next to photos.
      if (!imageOps) {
        await ensureHebrewFont();
        const shapes = slideXml.match(/<p:sp\b[\s\S]*?<\/p:sp>/g) ?? [];
        for (const sp of shapes) {
          const off = sp.match(/<a:off\b[^>]*>/)?.[0];
          const ext = sp.match(/<a:ext\b[^>]*>/)?.[0];
          if (!off || !ext) continue;
          const xE = Number(off.match(/\bx="(\d+)"/)?.[1] || 0);
          const yE = Number(off.match(/\by="(\d+)"/)?.[1] || 0);
          const wE = Number(ext.match(/\bcx="(\d+)"/)?.[1] || 0);
          const hE = Number(ext.match(/\bcy="(\d+)"/)?.[1] || 0);
          if (wE < 1 || hE < 1) continue;
          const lines = [...sp.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
            .map((m) => m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim())
            .filter(Boolean);
          if (!lines.length) continue;
          const left = (xE / cx) * W, top = (yE / cy) * H;
          const rw = Math.max(8, (wE / cx) * W), rh = Math.max(8, (hE / cy) * H);
          const fontPx = Math.max(11, Math.min(28, rh / Math.max(1, lines.length) * 0.7));
          g.fillStyle = "#0f172a";
          g.font = `${fontPx}px "${HEB_FONT}", sans-serif`;
          g.textAlign = "right";
          g.textBaseline = "top";
          const lineH = fontPx * 1.25;
          let y = top;
          for (const line of lines.slice(0, Math.max(1, Math.floor(rh / lineH)))) {
            g.fillText(line.slice(0, 120), left + rw - 4, y, rw - 8);
            y += lineH;
            if (y > top + rh) break;
          }
          imageOps++;
        }
      }
      if (!imageOps) {
        // Text-only slide: simple centered title so slides PDF still has a card.
        const title = text.split(/\n/).map((x) => x.trim()).find((x) => x.length >= 3)?.slice(0, 80);
        if (!title) continue;
        await ensureHebrewFont();
        g.fillStyle = "#1e293b";
        g.font = `bold 36px "${HEB_FONT}", sans-serif`;
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(title, W / 2, H / 2, W - 80);
        imageOps = 1;
      }
      // Trim empty slide chrome so photos fill the study-PDF frame (keep natural AR — no forced 16:9 zoom).
      const raw = c.toBuffer("image/jpeg", 82);
      const jpeg = (await trimWhitespace(raw, 82)) ?? raw;
      out.push({
        deck, page: i + 1, text, imageOps,
        score: 3 + Math.min(imageOps, 4) - Math.min(text.length / 300, 3),
        jpeg,
      });
    }
    return out;
  } catch (e) { console.warn("pptx media extraction failed:", (e as Error).message); return []; }
}
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
      if (!pdfData) {
        // No LibreOffice (Vercel): use the largest embedded picture of each slide straight from the PPTX zip.
        if (isPptx(d.mime, d.name) || d.name.toLowerCase().endsWith(".pptx")) all.push(...(await pptxMediaPages(d.name, d.data)).filter(p=>pageInRange(p.page,d.range)));
        continue;
      }
      const { pdf, pages } = await analyze(d.name, pdfData);
      docs.set(d.name, pdf); pdfBytes.set(d.name, pdfData); all.push(...pages.filter(p=>pageInRange(p.page,d.range)));
    }
    const max = MAX();
    // Pre-filter for cost: pages with images or vector drawings. Slides cited by a section go first (most likely relevant), then best-scoring; capped.
    const visual = all.filter((p) => (p.imageOps > 0 || p.score > 0) && !isTitleSlide(p));
    const isCited = (p: PageInfo) => citedSections(s, p.page).length > 0;
    const pool = [...visual.filter(isCited).sort((a, b) => b.score - a.score), ...visual.filter((p) => !isCited(p)).sort((a, b) => b.score - a.score)];
    const cands: PageInfo[] = [];
    for (const c of pool) {
      if (cands.length >= MAX_PAGES()) break;
      if (!c.jpeg) c.jpeg = await renderJpeg(docs.get(c.deck)!, pdfBytes.get(c.deck)!, c.page);
      if (c.jpeg.length < 3000) continue; // near-blank render → would print as an empty band
      c.sha = createHash("sha1").update(c.jpeg).digest("hex"); c.dhash = await dhash(c.jpeg);
      if (cands.some((k) => sameImage(k, c))) continue; // same slide in PDF+PPTX, or repeated slide: send once
      cands.push(c);
    }
    if (!cands.length) { lastFigureNote = `no candidate pages (${all.length} analyzed)`; return []; }
    const he = /[\u0590-\u05FF]/.test(s.overview + s.title);
    let picks: Pick[] | null = null;
    const key = mistralKey();
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
    }).filter((p) => p.section >= 0), Math.min(max, 4), PER_SECTION(), HEURISTIC_MIN_REL);
    if (!picks.length) lastFigureNote = "no relevant figures";
    const multi = decks.length > 1;
    return picks.sort((a, b) => a.section - b.section || a.c.deck.localeCompare(b.c.deck) || a.c.page - b.c.page)
      .map(({ c, section, caption }) => ({ page: c.page, deck: multi ? c.deck : undefined, caption, section, src: `data:image/jpeg;base64,${c.jpeg!.toString("base64")}` }));
  } catch (e) { lastFigureNote = `failed: ${(e as Error).message}`.slice(0, 300); console.warn("figure extraction failed, text-only PDF:", (e as Error).message); return []; }
}

/** True when a section's deck field refers to this file (exact or basename). */
export function sameSlideDeck(sectionDeck: string | undefined, fileName: string): boolean {
  if (!sectionDeck) return true;
  if (sectionDeck === fileName) return true;
  const base = (s: string) => s.replace(/^.*[/\\]/, "").toLowerCase();
  return base(sectionDeck) === base(fileName);
}

/**
 * Map each slides-density section to (page, deck). Duplicate page numbers across decks are kept
 * as separate targets. When `deck` is missing, infer from page-sequence restarts (1 after N>1).
 */
export function assignSlideFigureTargets(
  sections: { slide?: number; deck?: string; heading?: string; bullets?: string[] }[],
  deckNames: string[],
  cap = SLIDES_PAGE_CAP,
): { section: number; page: number; deck: string }[] {
  const raw: { section: number; page: number; deck?: string }[] = [];
  for (let i = 0; i < sections.length && raw.length < cap; i++) {
    const sec = sections[i]!;
    let p = sec.slide;
    if (typeof p !== "number" || p < 1) {
      const cited = [...sectionSlides({ heading: sec.heading ?? "", bullets: sec.bullets ?? [], slide: sec.slide, deck: sec.deck })];
      p = cited[0];
    }
    if (typeof p === "number" && p >= 1) raw.push({ section: i, page: p, deck: sec.deck });
  }
  if (!raw.length || !deckNames.length) return [];
  let di = 0;
  const out: { section: number; page: number; deck: string }[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!;
    if (t.deck) {
      const j = deckNames.findIndex((n) => sameSlideDeck(t.deck, n));
      if (j >= 0) di = j;
      out.push({ section: t.section, page: t.page, deck: deckNames[j >= 0 ? j : di]! });
      continue;
    }
    if (i > 0 && t.page === 1 && raw[i - 1]!.page > 1 && di < deckNames.length - 1) di++;
    out.push({ section: t.section, page: t.page, deck: deckNames[di]! });
  }
  return out;
}

/**
 * Slides-density PDF: render JPEG for each summary section that names a slide page (hard stop at SLIDES_PAGE_CAP).
 * Multi-deck lectures keep separate images when page numbers restart (page 1 in deck A and deck B).
 * Never throws — missing pages are skipped.
 */
export async function pickSlideDeckFigures(decks: SlideDeck[], s: LectureSummary, cap = SLIDES_PAGE_CAP): Promise<Figure[]> {
  lastFigureNote = !decks.length ? "no decks" : !s.sections?.length ? "no sections" : "";
  if (lastFigureNote) return [];
  try {
    const multi = decks.length > 1;
    const targets = assignSlideFigureTargets(s.sections, decks.map((d) => d.name), cap);
    if (!targets.length) { lastFigureNote = "no slide targets"; return []; }

    const out: Figure[] = [];
    const filled = new Set<number>();
    for (const d of decks) {
      const need = targets.filter((t) => !filled.has(t.section) && sameSlideDeck(t.deck, d.name));
      if (!need.length) continue;
      const pages = new Set(need.map((t) => t.page).filter((p) => pageInRange(p, d.range)));
      const rendered = new Map<number, Buffer>();

      if (isPptx(d.mime, d.name) || d.name.toLowerCase().endsWith(".pptx")) {
        for (const p of await pptxMediaPages(d.name, d.data, (pg) => pages.has(pg) && pageInRange(pg, d.range))) {
          if (p.jpeg && p.jpeg.length >= 3000) rendered.set(p.page, p.jpeg);
        }
      } else {
        const pdfData = d.mime.includes("pdf") || d.name.toLowerCase().endsWith(".pdf") ? d.data : null;
        if (!pdfData) continue;
        const { pdf } = await analyze(d.name, pdfData);
        const w = Math.max(WIDTH(), 1400);
        for (const page of pages) {
          try {
            const jpeg = await renderJpeg(pdf, pdfData, page, { width: w, quality: 82 });
            if (jpeg.length >= 3000) rendered.set(page, jpeg);
          } catch { /* skip missing page */ }
        }
      }

      for (const t of need) {
        const jpeg = rendered.get(t.page);
        if (!jpeg) continue;
        filled.add(t.section);
        out.push({
          page: t.page,
          deck: multi ? d.name : undefined,
          caption: multi ? `${d.name.replace(/^.*[/\\]/, "")} · שקף ${t.page}` : `שקף ${t.page}`,
          section: t.section,
          src: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
        });
      }
    }
    if (!out.length) lastFigureNote = "no slide renders";
    return out.sort((a, b) => a.section - b.section);
  } catch (e) {
    lastFigureNote = `slides figures failed: ${(e as Error).message}`.slice(0, 300);
    console.warn(lastFigureNote);
    return [];
  }
}
