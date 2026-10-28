/** Course-context pack: extract text once, retrieve small relevant excerpts per prompt. */
import { extractText, getDocumentProxy } from "unpdf";

export async function pdfToText(data: Buffer): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await extractText(pdf, { mergePages: false });
  return (text as string[]).join("\f");
}

const tokens = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);

/**
 * Naive lexical retrieval (no embeddings): split into ~1200-char chunks by page, score by overlap with the
 * query tokens (English terms weighted x3), return top chunks up to `budget` chars.
 * TODO: embeddings (Gemini text-embedding) once the course pack is large and lexical recall is poor.
 */
export function retrieveExcerpts(contextText: string | null | undefined, query: string, budget = 6000): string {
  if (!contextText) return "";
  const chunks: { page: number; text: string }[] = [];
  contextText.split("\f").forEach((p, i) => {
    for (let o = 0; o < p.length; o += 1200) chunks.push({ page: i + 1, text: p.slice(o, o + 1200).trim() });
  });
  const q = new Map<string, number>();
  for (const t of tokens(query)) q.set(t, /^[a-z]/.test(t) ? 3 : 1);
  const scored = chunks.filter((c) => c.text)
    .map((c) => ({ c, s: [...new Set(tokens(c.text))].reduce((n, t) => n + (q.get(t) ?? 0), 0) }))
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  let out = "";
  for (const { c } of scored) {
    const piece = `[course-pack p.${c.page}] ${c.text}\n`;
    if (out.length + piece.length > budget) break;
    out += piece;
  }
  return out;
}
