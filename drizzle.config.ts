import type { Config } from "drizzle-kit";
export default {
  schema: "./src/db/schema.ts",
  dialect: "turso",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "file:./data/local.db",
    authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
  },
} satisfies Config;
