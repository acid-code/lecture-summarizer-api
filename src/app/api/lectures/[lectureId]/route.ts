import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensureDb, schema } from "@/db";
import { checkAuth } from "@/lib/auth";
import { bad, notFound } from "@/lib/http";

type Ctx = { params: Promise<{ lectureId: string }> };
/** Attach Blob URLs after a client upload finishes. */
const Patch = z.object({ audioUrl: z.string().url().optional(), slidesUrl: z.string().url().optional() });

export async function GET(req: Request, { params }: Ctx) {
  const denied = checkAuth(req); if (denied) return denied;
  await ensureDb();
  const { lectureId } = await params;
  const lecture = await db.query.lectures.findFirst({ where: eq(schema.lectures.id, lectureId) });
  if (!lecture) return notFound();
  const jobs = await db.select().from(schema.jobs).where(eq(schema.jobs.lectureId, lectureId));
  return Response.json({ ...lecture, jobs });
}

export async function PATCH(req: Request, { params }: Ctx) {
  const denied = checkAuth(req); if (denied) return denied;
  const p = Patch.safeParse(await req.json().catch(() => null));
  if (!p.success) return bad(p.error.message);
  await ensureDb();
  const { lectureId } = await params;
  const [row] = await db.update(schema.lectures).set(p.data).where(eq(schema.lectures.id, lectureId)).returning();
  return row ? Response.json(row) : notFound();
}
