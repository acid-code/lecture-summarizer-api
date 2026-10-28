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
  /** True when the transcript was empty/very short vs slides (summary leans on slides). */
  transcript_thin?: boolean;
}
export interface AudioInput {
  url: string; mime: string; offsetSec: number; durationSec?: number;
  /** Optional ASR window inside this file (seconds, file-relative). Long audio is transcribed in ~6 min windows. */
  windowStart?: number; windowEnd?: number;
}
/** `audioEnded` is set when a window starts past the end of the audio (unknown-duration files). */
export interface WindowTranscript extends Transcript { audioEnded?: boolean }
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
  transcribe(audio: AudioInput, ctx: LectureContext): Promise<WindowTranscript>;
  repairTerms(t: Transcript, ctx: LectureContext): Promise<Repair[]>;
  summarize(t: Transcript, repairs: Repair[], ctx: LectureContext): Promise<LectureSummary>;
}
