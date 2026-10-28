import { getProvider } from "@/lib/providers";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({ ok: true, provider: getProvider().name, blob: !!process.env.BLOB_READ_WRITE_TOKEN });
}
