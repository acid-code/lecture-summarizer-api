export interface Segment { start: number; end: number; text: string }
export interface Transcript { language: string; segments: Segment[] }
export interface Repair { span: string; replacement: string; evidence: string; confidence: number }
export interface LectureSummary {
  title: string;
  /** Hebrew RTL prose with English technical terms inline. */
  overview: string;
  sections: { heading: string; bullets: string[]; citation?: string }[];
  glossary: { term: string; explanation: string }[];
}
export interface LectureContext { title: string; slidesUrl?: string | null; courseContextUrl?: string | null }

/** Behind an interface so ASR/LLM can move to ivrit-ai Whisper etc. via config later. */
export interface AiProvider {
  name: string;
  transcribe(audioUrl: string, ctx: LectureContext): Promise<Transcript>;
  repairTerms(t: Transcript, ctx: LectureContext): Promise<Repair[]>;
  summarize(t: Transcript, repairs: Repair[], ctx: LectureContext): Promise<LectureSummary>;
}
