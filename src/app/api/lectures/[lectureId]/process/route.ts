import { eq } from "drizzle-orm";
import { db, ensureDb, schema } from "@/db";
import { checkAuth } from "@/lib/auth";
import { id, notFound } from "@/lib/http";

type Ctx = { params: Promise<{ lectureId: string }> };

/** Create a queued job. Then call POST /api/jobs/{id}/advance until stage === "done". */
export async function POST(req: Request, { params }: Ctx) {
  const denied = checkAuth(req); if (denied) return denied;
  await ensureDb();
  const { lectureId } = await params;
  if (!(await db.query.lectures.findFirst({ where: eq(schema.lectures.id, lectureId) }))) return notFound();
  const [job] = await db.insert(schema.jobs).values({ id: id(), lectureId, stage: "queued", updatedAt: Date.now() }).returning();
  return Response.json(job, { status: 202 });
}
