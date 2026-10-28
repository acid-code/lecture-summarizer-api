/**
 * HTML → PDF via headless Chrome (puppeteer-core). Works where a Chrome binary exists (box/dev, CHROME_PATH).
 * On Vercel there is no system Chrome: TODO @sparticuz/chromium or typst-wasm (templates/study.typ).
 * Returns null when no browser is available → caller falls back to the print-ready RTL HTML.
 */
import { existsSync } from "node:fs";

const candidates = () => [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean) as string[];

export async function htmlToPdf(html: string): Promise<Buffer | null> {
  if (process.env.PDF_RENDERER === "html") return null;
  const exe = candidates().find((p) => existsSync(p));
  if (!exe) return null;
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return Buffer.from(await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }));
  } finally {
    await browser.close();
  }
}
