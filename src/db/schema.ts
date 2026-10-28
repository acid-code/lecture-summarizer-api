import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** Optional old course summary PDF (Blob URL) — background context only. */
  contextPdfUrl: text("context_pdf_url"),
  createdAt: integer("created_at").notNull(),
});

export const lectures = sqliteTable("lectures", {
  id: text("id").primaryKey(),
  courseId: text("course_id").notNull().references(() => courses.id),
  title: text("title").notNull(),
  audioUrl: text("audio_url"),
  /** Optional lecture slides (PDF/PPTX) Blob URL. */
  slidesUrl: text("slides_url"),
  createdAt: integer("created_at").notNull(),
});

export const STAGES = ["queued", "asr", "repair", "summary", "pdf", "done"] as const;
export type Stage = (typeof STAGES)[number];

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  lectureId: text("lecture_id").notNull().references(() => lectures.id),
  stage: text("stage").$type<Stage | "failed">().notNull().default("queued"),
  error: text("error"),
  /** JSON map stage -> artifact (inline JSON or URL). */
  artifacts: text("artifacts").notNull().default("{}"),
  updatedAt: integer("updated_at").notNull(),
});
