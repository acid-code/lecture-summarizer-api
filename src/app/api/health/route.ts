import { getProvider } from "@/lib/providers";
export const dynamic = "force-dynamic";
export function GET() {
  return Response.json({
    ok: true,
    provider: getProvider().name,
    storage: process.env.R2_BUCKET_NAME ? "r2" : "local",
  });
}
