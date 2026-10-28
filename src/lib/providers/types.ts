export interface Segment { start: number; end: number; text: string }
export interface Transcript { language: string; segments: Segment[] }
/** A proposed term fix with evidence — an edit list, never a rewritten transcript. */
export interface Repair { segment?: number; span: string; replacement: string; evidence: string; confidence: number }
export interface LectureSummary {
  title: string;
  /** Hebrew RTL prose with English technical terms inline. */
  overview: string;
  sections: { heading: string; bullets: string[]; citation?: string }[];
  glossary: { term: string; explanation: string }[];
}
export interface AudioInput { url: string; mime: string; offsetSec: number }
export interface LectureContext {
  title: string;
  slidesUrl?: string | null;
  /** Extracted slide text (cheap to put in prompts). */
  slidesText?: string | null;
  /** Retrieved excerpts from the course-context pack (never the whole PDF). */
  courseExcerpts?: (query: string, budget?: number) => string;
}

/** Behind an interface so ASR/LLM can move to ivrit-ai Whisper etc. via config later. */
export interface AiProvider {
  name: string;
  transcribe(audio: AudioInput, ctx: LectureContext): Promise<Transcript>;
  repairTerms(t: Transcript, ctx: LectureContext): Promise<Repair[]>;
  summarize(t: Transcript, repairs: Repair[], ctx: LectureContext): Promise<LectureSummary>;
}
