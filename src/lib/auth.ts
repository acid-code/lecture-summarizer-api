/**
 * Auth: shared bearer API_TOKEN (gate) + per-install device id (X-Device-Id) that scopes all data.
 */
/** deviceId null = legacy client (no X-Device-Id): may only see/write unclaimed (device_id IS NULL) courses. */
export type AuthOk = { deviceId: string | null };
const DEVICE_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function authenticate(req: Request): AuthOk | Response {
  const token = process.env.API_TOKEN;
  if (token && req.headers.get("authorization") !== `Bearer ${token}`)
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const dev = req.headers.get("x-device-id")?.trim();
  // Backward compat (old APK mid-recording): no header -> legacy scope, unless LEGACY_CLIENTS=off.
  if (!dev) {
    if (process.env.LEGACY_CLIENTS === "off") return Response.json({ error: "missing X-Device-Id header (update the app)" }, { status: 401 });
    return { deviceId: null };
  }
  if (!DEVICE_RE.test(dev)) return Response.json({ error: "invalid X-Device-Id" }, { status: 400 });
  return { deviceId: dev };
}

/** Legacy: token-only check (used by the Blob token route). */
export function checkAuth(req: Request): Response | null {
  const token = process.env.API_TOKEN;
  if (!token) return null;
  if (req.headers.get("authorization") === `Bearer ${token}`) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
