import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, ensureDb, schema } from "@/db";
import { checkAuth } from "@/lib/auth";
import { bad, id, notFound } from "@/lib/http";

const Body = z.object({
  title: z.string().min(1),
  audioUrl: z.string().url().optional(),
  slidesUrl: z.string().url().optional(),
});
type Ctx = { params: Promise<{ courseId: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const denied = checkAuth(req); if (denied) return denied;
  await ensureDb();
  const { courseId } = await params;
  return Response.json(await db.select().from(schema.lectures).where(eq(schema.lectures.courseId, courseId)));
}

export async function POST(req: Request, { params }: Ctx) {
  const denied = checkAuth(req); if (denied) return denied;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return bad(p.error.message);
  await ensureDb();
  const { courseId } = await params;
  if (!(await db.query.courses.findFirst({ where: eq(schema.courses.id, courseId) }))) return notFound();
  const [row] = await db.insert(schema.lectures).values({ id: id(), courseId, ...p.data, createdAt: Date.now() }).returning();
  return Response.json(row, { status: 201 });
}
