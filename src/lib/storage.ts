import { put, del } from "@vercel/blob";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";

const LOCAL = "local:";
const useBlob = () => !!process.env.BLOB_READ_WRITE_TOKEN;

/**
 * Store a file. Vercel Blob if BLOB_READ_WRITE_TOKEN is set, else ./data/<dir>/ (returned as "local:<relpath>").
 * Local fallback lets the box/dev machine playtest uploads without Blob.
 */
export async function saveFile(dir: "uploads" | "artifacts", name: string, body: Buffer | string, contentType: string): Promise<string> {
  const safe = name.replace(/[^\w.\-]/g, "_");
  if (useBlob()) {
    const blob = await put(`${dir}/${safe}`, body, { access: "public", contentType, addRandomSuffix: true });
    return blob.url; // public-but-unguessable URL; consider private access (verify Blob private support)
  }
  const rel = path.join("data", dir, `${crypto.randomUUID().slice(0, 8)}-${safe}`);
  await mkdir(path.dirname(rel), { recursive: true });
  await writeFile(rel, body);
  return LOCAL + rel;
}
export const saveArtifact = (name: string, body: Buffer | string, ct: string) => saveFile("artifacts", name, body, ct);

export async function readFileUrl(url: string): Promise<{ data: Buffer; mime?: string }> {
  if (url.startsWith(LOCAL)) return { data: await readFile(path.join(process.cwd(), url.slice(LOCAL.length))) };
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`);
  return { data: Buffer.from(await r.arrayBuffer()), mime: r.headers.get("content-type") ?? undefined };
}

export async function deleteFileUrl(url: string) {
  if (url.startsWith(LOCAL)) await unlink(path.join(process.cwd(), url.slice(LOCAL.length))).catch(() => {});
  else if (useBlob()) await del(url);
}

/**
 * Validate a client-supplied file URL (JSON {url} uploads): only this deployment's Blob store
 * (*.blob.vercel-storage.com) or a local: path under data/uploads. Prevents SSRF / path traversal.
 */
export function isAcceptableUploadUrl(url: string): boolean {
  if (url.startsWith(LOCAL)) return !url.includes("..") && url.slice(LOCAL.length).startsWith(path.join("data", "uploads") + "/");
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(".blob.vercel-storage.com");
  } catch { return false; }
}
