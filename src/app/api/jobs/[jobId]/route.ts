/** Legacy un-scoped /api route, retired 2026-11 (per-device isolation). Use /v1 with X-Device-Id. */
const gone = () => Response.json({ error: "gone: use /v1 (per-device API)" }, { status: 410 });
export { gone as GET };
