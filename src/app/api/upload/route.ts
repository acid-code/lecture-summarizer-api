import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

/**
 * Token route for Vercel Blob CLIENT uploads. The browser/phone uploads audio + slides directly
 * to Blob, bypassing the 4.5 MB function body limit. Then PATCH /api/lectures/{id} with the URL.
 * The Blob store is private, so clients MUST upload with access "private".
 * Client: `upload(name, file, { access: "private", handleUploadUrl: "/api/upload", multipart: true,
 *          clientPayload: JSON.stringify({ token }) })` from "@vercel/blob/client".
 */
export async function POST(req: Request) {
  const body = (await req.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        // Auth stub: upload-token requests carry the API token in clientPayload.
        const token = process.env.API_TOKEN;
        if (token && JSON.parse(clientPayload || "{}").token !== token) throw new Error("unauthorized");
        return {
          allowedContentTypes: [
            "audio/*", "application/pdf",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          ],
          maximumSizeInBytes: 200 * 1024 * 1024, // ~50 min m4a is ~20-80 MB
          addRandomSuffix: true,
        };
      },
      // Called by Blob after upload (not on localhost without a tunnel).
      onUploadCompleted: async ({ blob }) => { console.log("upload completed", blob.pathname); },
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
