export interface Segment { start: number; end: number; text: string }
export interface Transcript { language: string; segments: Segment[] }
/** A proposed term fix with evidence — an edit list, never a rewritten transcript. */
export interface Repair { segment?: number; span: string; replacement: string; evidence: string; confidence: number }
export interface LectureSummary {
  title: string;
  /** Hebrew RTL prose with English technical terms inline. */
  overview: string;
  /** style "prose": bullets are full paragraphs (rendered as <p>, not <li>). */
  sections: { heading: string; bullets: string[]; citation?: string; style?: "prose" }[];
  glossary: { term: string; explanation: string }[];
  /** True when the transcript was empty/very short vs slides (summary leans on slides). */
  transcript_thin?: boolean;
  /** Optional end-of-PDF "big picture" in English: main themes + what the lecture was trying to teach. Supplements, never replaces. */
  big_picture?: BigPicture | null;
}
export interface BigPicture {
  /** 2-4 sentences: what the lecturer was trying to teach and why the examples were chosen. */
  intent: string;
  themes: { title: string; explanation: string }[];
  /** Key terms used in the lecture (e.g. "literal") that the main summary did not explain. */
  missed_terms?: { term: string; explanation: string }[];
}
export interface AudioInput {
  url: string; mime: string; offsetSec: number; durationSec?: number;
  /** Optional ASR window inside this file (seconds, file-relative). Long audio is transcribed in ~6 min windows. */
  windowStart?: number; windowEnd?: number;
  /** Tail of the transcript before windowStart, so the model continues after it instead of re-transcribing it. */
  prevText?: string;
}
/** `audioEnded` is set when a window starts past the end of the audio (unknown-duration files). */
export interface WindowTranscript extends Transcript { audioEnded?: boolean }
export interface LectureContext {
  title: string;
  slidesUrl?: string | null;
  /** Extracted slide text (cheap to put in prompts). */
  slidesText?: string | null;
  /** No audio: summarize from presentation/PDF materials only (no transcript, no [t=] cites). */
  slidesOnly?: boolean;
  /** Retrieved excerpts from the course-context pack (never the whole PDF). */
  courseExcerpts?: (query: string, budget?: number) => string;
  /** Summary density: compact (short review sheet), standard (default study notes), detailed (near-exhaustive). */
  density?: Density;
}
export type Density = "compact" | "standard" | "detailed";
export const DENSITIES: Density[] = ["compact", "standard", "detailed"];
export const parseDensity = (v: unknown): Density | undefined => DENSITIES.includes(v as Density) ? v as Density : undefined;

/** Behind an interface so ASR/LLM can move to ivrit-ai Whisper etc. via config later. */
export interface AiProvider {
  name: string;
  transcribe(audio: AudioInput, ctx: LectureContext): Promise<WindowTranscript>;
  repairTerms(t: Transcript, ctx: LectureContext): Promise<Repair[]>;
  summarize(t: Transcript, repairs: Repair[], ctx: LectureContext): Promise<LectureSummary>;
  /** Long lectures: resumable hierarchical summary step; null = not finished (state updated, call again). */
  hierarchicalStep?(t: Transcript, ctx: LectureContext, state: import("./hierarchical").HierState, deadline: number): Promise<LectureSummary | null>;
}
