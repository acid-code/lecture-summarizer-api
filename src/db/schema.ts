import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  langPrimary: text("lang_primary").notNull().default("he"),
  /** Optional old course summary PDF (~150-200p) — background context only. */
  contextPdfUrl: text("context_pdf_url"),
  /** Extracted plain text of the context PDF, page-delimited by \f. Excerpts are retrieved per prompt. */
  contextText: text("context_text"),
  createdAt: integer("created_at").notNull(),
});

export const lectures = sqliteTable("lectures", {
  id: text("id").primaryKey(),
  courseId: text("course_id").notNull().references(() => courses.id),
  title: text("title").notNull(),
  recordedAt: text("recorded_at"),
  /** Legacy single-file audio (web client). Android uploads segments instead. */
  audioUrl: text("audio_url"),
  /** Optional lecture slides (PDF/PPTX). */
  slidesUrl: text("slides_url"),
  slidesText: text("slides_text"),
  /** JSON [{t_sec,page,label}] */
  markers: text("markers").notNull().default("[]"),
  createdAt: integer("created_at").notNull(),
});

export const segments = sqliteTable("segments", {
  id: text("id").primaryKey(),
  lectureId: text("lecture_id").notNull().references(() => lectures.id),
  seq: integer("seq").notNull(),
  startedAt: text("started_at"),
  duration: real("duration"),
  url: text("url"), // null after raw-audio cleanup
  mime: text("mime").notNull().default("audio/mp4"),
  createdAt: integer("created_at").notNull(),
});

/**
 * Lecture materials: several slide decks / PDFs per lecture (added 2026-10). Legacy lectures.slides_url stays
 * as "first deck" for old readers; lectures.slides_text is the concatenation of all decks' text.
 */
export const lectureFiles = sqliteTable("lecture_files", {
  id: text("id").primaryKey(),
  lectureId: text("lecture_id").notNull().references(() => lectures.id),
  kind: text("kind").notNull().default("slides"),
  name: text("name").notNull(),
  mime: text("mime").notNull(),
  url: text("url").notNull(),
  text: text("text"),
  size: integer("size"),
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
