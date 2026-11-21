import { createPresignedUploadUrl, useR2 } from "@/lib/storage";

/**
 * Presigned R2 upload route. The browser/phone PUTs the file directly to R2,
 * bypassing the 4.5 MB function body limit.
 */
export async function POST(req: Request) {
  try {
    if (!useR2()) return Response.json({ error: "R2 storage is not configured" }, { status: 503 });
    const body = await req.json();
    const filename = typeof body.filename === "string" ? body.filename : "";
    const contentType = typeof body.contentType === "string"
      ? body.contentType
      : typeof body.content_type === "string" ? body.content_type : "";
    const size = typeof body.size === "number" ? body.size : 0;
    const token = process.env.API_TOKEN;
    if (token) {
      const payload = typeof body.clientPayload === "string" ? JSON.parse(body.clientPayload || "{}") : body;
      if (payload.token !== token) throw new Error("unauthorized");
    }
    if (!filename || !contentType) throw new Error("filename and contentType are required");
    if (!/^(audio\/|application\/pdf$|application\/vnd\.openxmlformats-officedocument\.presentationml\.presentation$)/.test(contentType)) {
      throw new Error("content type not allowed");
    }
    const upload = await createPresignedUploadUrl("uploads", filename, contentType, 60 * 60, size);
    return Response.json({
      mode: "r2",
      method: "PUT",
      put_url: upload.url,
      url: `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${upload.key}`,
      headers: { "content-type": contentType },
      expires_at: upload.expiresAt,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
