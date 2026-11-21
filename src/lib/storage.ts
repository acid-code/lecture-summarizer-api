import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";

const LOCAL = "local:";
const BUCKET = process.env.R2_BUCKET_NAME || "";
const REGION = "auto"; // R2 uses "auto"
export const R2_STORAGE_LIMIT_BYTES = 7 * 1024 * 1024 * 1024;

/** Create R2 S3 client. */
function r2Client() {
  return new S3Client({
    region: REGION,
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
    },
    forcePathStyle: false, // R2 uses virtual-hosted style
  });
}

/** Blob access mode. Always private: lecture audio must not be world-readable (store must be private). */
export const blobAccess = (): "private" => "private";
export const useR2 = () => !!(
  process.env.R2_ACCOUNT_ID
  && process.env.R2_ACCESS_KEY_ID
  && process.env.R2_SECRET_ACCESS_KEY
  && BUCKET
);

export function isR2ObjectUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const r2Host = `${BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    return u.protocol === "https:" && u.hostname === r2Host;
  } catch {
    return false;
  }
}

function r2KeyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const r2Host = `${BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
    if (u.protocol !== "https:" || u.hostname !== r2Host) return null;
    return decodeURIComponent(u.pathname.slice(1));
  } catch {
    return null;
  }
}

export async function createPresignedUploadUrl(
  dir: "uploads" | "artifacts",
  name: string,
  contentType: string,
  expiresIn = 60 * 60,
  incomingBytes = 0,
): Promise<{ url: string; key: string; expiresAt: string }> {
  if (!useR2()) throw new Error("R2 storage is not configured");
  await enforceR2StorageLimit(incomingBytes);
  const safe = name.replace(/[^\w.\-]/g, "_");
  const key = `${dir}/${crypto.randomUUID()}-${safe}`;
  const url = await getSignedUrl(r2Client(), new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  }), { expiresIn });
  return { url, key, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
}

export async function listR2Objects(prefix?: string): Promise<{ key: string; url: string; size: number }[]> {
  if (!useR2()) return [];
  const out: { key: string; url: string; size: number }[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await r2Client().send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const object of page.Contents || []) {
      if (!object.Key) continue;
      out.push({
        key: object.Key,
        url: `https://${BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${object.Key}`,
        size: object.Size || 0,
      });
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

export async function enforceR2StorageLimit(incomingBytes: number): Promise<void> {
  if (!useR2()) return;
  if (!Number.isSafeInteger(incomingBytes) || incomingBytes < 0) {
    throw new Error("invalid upload size");
  }
  if (incomingBytes > R2_STORAGE_LIMIT_BYTES) {
    throw new Error("upload exceeds the 7 GB storage limit");
  }
  const objects = await listR2Objects();
  const usedBytes = objects.reduce((sum, object) => sum + object.size, 0);
  if (usedBytes + incomingBytes > R2_STORAGE_LIMIT_BYTES) {
    throw new Error("R2 storage limit reached (7 GB)");
  }
}

/**
 * Store a file in R2. Returns the direct S3 URL.
 * Local fallback for dev: ./data/<dir>/
 */
export async function saveFile(dir: "uploads" | "artifacts", name: string, body: Buffer | string, contentType: string): Promise<string> {
  const safe = name.replace(/[^\w.\-]/g, "_");
  if (useR2()) {
    const bodyBuf = typeof body === "string" ? Buffer.from(body) : body;
    await enforceR2StorageLimit(bodyBuf.byteLength);
    const key = `${dir}/${crypto.randomUUID()}-${safe}`;
    const client = r2Client();
    await client.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: bodyBuf,
      ContentType: contentType,
    }));
    // R2 URL (file will be private via bucket policy)
    return `https://${BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;
  }
  const rel = path.join("data", dir, `${crypto.randomUUID().slice(0, 8)}-${safe}`);
  await mkdir(path.dirname(rel), { recursive: true });
  await writeFile(rel, body);
  return LOCAL + rel;
}
export const saveArtifact = (name: string, body: Buffer | string, ct: string) => saveFile("artifacts", name, body, ct);

/** Read a file from R2 by its direct URL. */
export async function readFileUrl(url: string): Promise<{ data: Buffer; mime?: string }> {
  if (url.startsWith(LOCAL)) return { data: await readFile(path.join(process.cwd(), url.slice(LOCAL.length))) };
  const key = r2KeyFromUrl(url);
  if (useR2() && key) {
    const client = r2Client();
    const r = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    if (!r.Body) throw new Error(`empty response from R2: ${url}`);
    const data = Buffer.from(await r.Body.transformToByteArray());
    return { data, mime: r.ContentType || undefined };
  }
  if (url.startsWith("https://")) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`legacy file not readable: HTTP ${response.status}`);
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mime: response.headers.get("content-type") || undefined,
    };
  }
  throw new Error(`readFileUrl unsupported: no R2 or local storage configured`);
}

/** Delete a file from R2 by its direct URL. */
export async function deleteFileUrl(url: string) {
  if (url.startsWith(LOCAL)) {
    await unlink(path.join(process.cwd(), url.slice(LOCAL.length))).catch(() => {});
    return;
  }
  const key = r2KeyFromUrl(url);
  if (useR2() && key) {
    const client = r2Client();
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
  }
}

/**
 * Validate a client-supplied file URL: only this deployment's R2 bucket (or Vercel Blob legacy),
 * or a local: path under data/uploads. Prevents SSRF / path traversal.
 */
export function isAcceptableUploadUrl(url: string): boolean {
  if (url.startsWith(LOCAL)) return !url.includes("..") && url.slice(LOCAL.length).startsWith(path.join("data", "uploads") + "/");
  try {
    const u = new URL(url);
    // Accept R2 bucket URL or legacy Vercel Blob URL
    if (u.protocol === "https:") {
      const r2Host = `${BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
      if (u.hostname === r2Host) return true;
      if (u.hostname.endsWith(".blob.vercel-storage.com")) return true;
    }
    return false;
  } catch { return false; }
}
