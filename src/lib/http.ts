export const id = () => crypto.randomUUID();
export const notFound = () => Response.json({ error: "not found" }, { status: 404 });
export const bad = (msg: string) => Response.json({ error: msg }, { status: 400 });
