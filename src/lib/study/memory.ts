import type {LectureSummary} from "../providers/types";
/** No model call. Hierarchical summaries reuse their already-generated definitions; old lectures use glossary. */
export function memoryPairs(summary:Partial<LectureSummary>|undefined):{term:string;definition:string}[]{
 const candidates=summary?.memory_pairs?.length?summary.memory_pairs:(summary?.glossary??[]).map(g=>({term:g.term,definition:g.explanation}));
 const seen=new Set<string>();return candidates.flatMap(pair=>{
  if(typeof pair?.term!=="string"||typeof pair?.definition!=="string")return [];
  const term=pair.term.replace(/\[t=[^\]]*\]/gu,"").trim().slice(0,40);
  const definition=pair.definition.replace(/\[t=[^\]]*\]/gu,"").replace(/\s+/gu," ").trim().slice(0,100);
  const key=term.normalize("NFKC").toLowerCase();if(!term||!definition||seen.has(key))return [];seen.add(key);return [{term,definition}];
 }).slice(0,16);
}
export function memoryPairsHeader(summary:Partial<LectureSummary>|undefined){return Buffer.from(JSON.stringify(memoryPairs(summary)),"utf8").toString("base64");}
