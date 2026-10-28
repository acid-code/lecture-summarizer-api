import { z } from "zod";
import { db, ensureDb, schema } from "@/db";
import { checkAuth } from "@/lib/auth";
import { bad, id } from "@/lib/http";

const Body = z.object({ name: z.string().min(1), contextPdfUrl: z.string().url().optional() });

export async function GET(req: Request) {
  const denied = checkAuth(req); if (denied) return denied;
  await ensureDb();
  return Response.json(await db.select().from(schema.courses));
}

export async function POST(req: Request) {
  const denied = checkAuth(req); if (denied) return denied;
  const p = Body.safeParse(await req.json().catch(() => null));
  if (!p.success) return bad(p.error.message);
  await ensureDb();
  const [row] = await db.insert(schema.courses).values({ id: id(), ...p.data, createdAt: Date.now() }).returning();
  return Response.json(row, { status: 201 });
}
