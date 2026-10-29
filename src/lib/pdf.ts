/**
 * HTML → PDF via headless Chromium (puppeteer-core).
 *  - Local/box: system Chrome (CHROME_PATH or /usr/bin/{google-chrome,chromium,chromium-browser}).
 *  - Vercel/Lambda (or PDF_RENDERER=sparticuz): @sparticuz/chromium (brotli-packed binary, unpacked to /tmp).
 * The Hebrew font (IBM Plex Sans Hebrew, OFL, ./fonts) is inlined as @font-face so the PDF embeds it even
 * where no system fonts exist. Returns null when no browser is available → caller serves HTML instead.
 * PDF_RENDERER=html disables PDF entirely.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const candidates = () => [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean) as string[];
const serverless = () => process.env.PDF_RENDERER === "sparticuz" || !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

let fontCss: string | undefined;
function embeddedFontCss(): string {
  if (fontCss !== undefined) return fontCss;
  const face = (file: string, weight: number) => {
    const p = path.join(process.cwd(), "fonts", file);
    if (!existsSync(p)) return "";
    return `@font-face{font-family:"IBM Plex Sans Hebrew";font-weight:${weight};src:url(data:font/ttf;base64,${readFileSync(p).toString("base64")}) format("truetype")}`;
  };
  const katexCss = path.join(process.cwd(), "fonts", "katex-inline.css");
  fontCss = face("IBMPlexSansHebrew-Regular.ttf", 400) + face("IBMPlexSansHebrew-Bold.ttf", 700)
    + (existsSync(katexCss) ? readFileSync(katexCss, "utf8") : ""); // KaTeX CSS with woff2 fonts as data: URLs
  return fontCss;
}

async function launch() {
  const puppeteer = (await import("puppeteer-core")).default;
  if (serverless()) {
    const chromium = (await import("@sparticuz/chromium")).default;
    return puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
  }
  const exe = candidates().find((p) => existsSync(p));
  if (!exe) return null;
  return puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
}

export async function htmlToPdf(html: string): Promise<Buffer | null> {
  if (process.env.PDF_RENDERER === "html") return null;
  const browser = await launch().catch((e) => { console.error("pdf: browser launch failed", e); return null; });
  if (!browser) return null;
  try {
    const page = await browser.newPage();
    const withFont = html.replace("<style>", () => `<style>${embeddedFontCss()}`);
    await page.setContent(withFont, { waitUntil: "load" });
    await page.evaluateHandle("document.fonts.ready");
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
  } finally {
    await browser.close();
  }
}
