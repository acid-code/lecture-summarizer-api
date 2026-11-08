import { and,desc,eq } from "drizzle-orm";
import { z } from "zod";
import { db,schema } from "@/db";
import { ownsLecture } from "../v1/handlers";
import { storedSlideRange } from "../slide-ranges";
import { tutorJson } from "../providers/gemini";
import { geminiConfigured } from "../providers/keys";
import { chunks,runTutor,type Source } from "./tutor";
import { tutorLimit } from "./rate";
const input=z.object({question:z.string().trim().min(1).max(1200),language:z.enum(["he","en"]),previous_questions:z.array(z.string().trim().min(1).max(400)).max(3).default([])}).strict();
function strings(x:unknown):string[]{if(typeof x==="string")return [x];if(Array.isArray(x))return x.flatMap(strings);if(x&&typeof x==="object")return Object.values(x).flatMap(strings);return [];}
/** Whole-course grounding, after device ownership validation; current lecture is always first. */
export async function lectureSources(lid:string,deviceId:string):Promise<Source[]>{
 if(!await ownsLecture(deviceId,lid))return [];
 const current=await db.query.lectures.findFirst({where:eq(schema.lectures.id,lid)});if(!current)return [];
 const lectures=await db.query.lectures.findMany({where:eq(schema.lectures.courseId,current.courseId)});
 lectures.sort((a,b)=>Number(b.id===lid)-Number(a.id===lid)||(b.recordedAt??"").localeCompare(a.recordedAt??"")||a.id.localeCompare(b.id));
 const budget=Math.max(1,Math.min(10000,Math.floor(120000/Math.max(1,lectures.length))));const out:Source[]=[];
 for(const lecture of lectures){
  const label=`${lecture.title} · ${lecture.recordedAt??"date unavailable"}`;let remaining=budget;
  const add=(kind:Source["kind"],text:string,prefix:string)=>{if(remaining<=0)return;const bounded=text.slice(0,remaining);remaining-=bounded.length;out.push(...chunks(kind,label,bounded,`${lecture.id}:${prefix}`));};
  const jobs=await db.query.jobs.findMany({where:eq(schema.jobs.lectureId,lecture.id),orderBy:desc(schema.jobs.updatedAt)});
  let transcriptText="",summaryText="";
  for(const job of jobs){let a:Record<string,any>;try{a=JSON.parse(job.artifacts);}catch{continue;}
   if(!transcriptText){const t=[a.repaired,a.asr].find(t=>Array.isArray(t?.segments)&&t.segments.length);if(t)transcriptText=t.segments.map((s:any)=>`[${Number(s.start)||0}s] ${typeof s.text==="string"?s.text:""}`).join("\n");}
   if(!summaryText&&job.stage==="done"&&a.summary)summaryText=strings(a.summary).join("\n");
  }
  // Summary-first context keeps every lecture's main ideas available for generic queries.
  add("summary",summaryText.slice(0,Math.floor(budget*.55)),"s");
  add("transcript",transcriptText.slice(0,Math.floor(budget*.35)),"t");
  const files=await db.query.lectureFiles.findMany({where:and(eq(schema.lectureFiles.lectureId,lecture.id),eq(schema.lectureFiles.kind,"slides")),orderBy:schema.lectureFiles.createdAt});
  const deckBudget=Math.floor(remaining/Math.max(1,files.filter(f=>f.text).length));
  for(const [i,f] of files.entries()){if(!f.text)continue;const range=storedSlideRange(f.slideRange);const text=f.text.split("\f").filter((_,p)=>!range||(p+1>=range.start&&p+1<=range.end)).join("\n");add("slides",text.slice(0,deckBudget),`d${i}`);}
  if(!files.length&&lecture.slidesText)add("slides",lecture.slidesText,"legacy");
 }
 return out;
}
export async function tutorHandler(req:Request,lid:string,deviceId:string|null){
 try{return await handleTutor(req,lid,deviceId);}catch{return Response.json({error:"tutor_unavailable"},{status:503});}
}
async function handleTutor(req:Request,lid:string,deviceId:string|null){
 if(!deviceId)return Response.json({error:"device_required"},{status:401});
 if(!await ownsLecture(deviceId,lid))return Response.json({error:"not_found"},{status:404});
 const reader=req.body?.getReader();if(!reader)return Response.json({error:"invalid_request"},{status:400});
 let body="",bytes=0;const decode=new TextDecoder();
 for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>8192){await reader.cancel();return Response.json({error:"request_too_large"},{status:413});}body+=decode.decode(value,{stream:true});}body+=decode.decode();
 let raw:unknown;try{raw=JSON.parse(body);}catch{return Response.json({error:"invalid_request"},{status:400});}
 const parsed=input.safeParse(raw);if(!parsed.success)return Response.json({error:"invalid_request"},{status:400});
 const retry=await tutorLimit(deviceId);if(retry)return Response.json({error:"rate_limited",retry_after:retry},{status:429,headers:{"Retry-After":String(retry)}});
 const sources=await lectureSources(lid,deviceId);if(!sources.length)return Response.json({error:"material_not_ready"},{status:409});
 if(!process.env.API_TOKEN||!geminiConfigured())return Response.json({error:"tutor_unavailable"},{status:503});
 try{return Response.json(await runTutor(parsed.data.question,parsed.data.language,sources,tutorJson,parsed.data.previous_questions),{headers:{"Cache-Control":"no-store"}});}
 catch{return Response.json({error:"tutor_unavailable"},{status:503});}
}
