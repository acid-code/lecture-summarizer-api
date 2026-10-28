import { checkAuth } from "@/lib/auth";
import { advanceJob } from "@/lib/pipeline";

export const maxDuration = 300; // Vercel Hobby hard max (Fluid Compute)

/** Run the next pipeline stage. One stage per request keeps each call under the Hobby limit. */
export async function POST(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const denied = checkAuth(req); if (denied) return denied;
  const { jobId } = await params;
  try {
    const job = await advanceJob(jobId);
    return Response.json({ id: job.id, stage: job.stage, error: job.error });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}
