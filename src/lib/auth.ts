/** Auth stub: single shared bearer token. Replace with real auth (e.g. Auth.js) later. */
export function checkAuth(req: Request): Response | null {
  const token = process.env.API_TOKEN;
  if (!token) return null; // disabled for local dev
  if (req.headers.get("authorization") === `Bearer ${token}`) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
