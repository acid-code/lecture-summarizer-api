import { eq } from "drizzle-orm";
import { db, ensureDb, schema } from "@/db";
import { checkAuth } from "@/lib/auth";
import { notFound } from "@/lib/http";

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const denied = checkAuth(req); if (denied) return denied;
  await ensureDb();
  const { jobId } = await params;
  const job = await db.query.jobs.findFirst({ where: eq(schema.jobs.id, jobId) });
  return job ? Response.json({ ...job, artifacts: JSON.parse(job.artifacts) }) : notFound();
}
