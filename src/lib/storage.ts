import { put } from "@vercel/blob";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Store a generated artifact (PDF/HTML/JSON). Vercel Blob if configured, else ./data/artifacts. */
export async function saveArtifact(name: string, body: string | Buffer, contentType: string): Promise<string> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(`artifacts/${name}`, body, { access: "public", contentType, addRandomSuffix: true });
    return blob.url; // NOTE: public-but-unguessable URL; consider private access (verify Blob private support)
  }
  const dir = path.join(process.cwd(), "data", "artifacts");
  await mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await writeFile(p, body);
  return `file://${p}`;
}
