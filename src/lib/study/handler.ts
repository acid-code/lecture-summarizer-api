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
/** All grounding comes from this lecture's server rows, never client context or course-wide files. */
export async function lectureSources(lid:string):Promise<Source[]>{
 const lecture=await db.query.lectures.findFirst({where:eq(schema.lectures.id,lid)});if(!lecture)return [];
 const jobs=await db.query.jobs.findMany({where:eq(schema.jobs.lectureId,lid),orderBy:desc(schema.jobs.updatedAt),limit:12});
 const sources:Source[]=[];let transcript=false,summary=false;
 for(const job of jobs){let a:Record<string,any>;try{a=JSON.parse(job.artifacts);}catch{continue;}
   if(!transcript){const t=a.repaired??a.asr;if(Array.isArray(t?.segments)&&t.segments.length){sources.push(...chunks("transcript","Transcript",t.segments.map((s:any)=>`[${Number(s.start)||0}s] ${typeof s.text==="string"?s.text:""}`).join("\n"),"t"));transcript=true;}}
   if(!summary&&job.stage==="done"&&a.summary){sources.push(...chunks("summary","Summary",strings(a.summary).join("\n"),"s"));summary=true;}
 }
 const files=await db.query.lectureFiles.findMany({where:and(eq(schema.lectureFiles.lectureId,lid),eq(schema.lectureFiles.kind,"slides")),orderBy:schema.lectureFiles.createdAt,limit:20});
 for(const [i,f] of files.entries()){if(!f.text)continue;const range=storedSlideRange(f.slideRange);const pages=f.text.split("\f");for(let p=0;p<pages.length&&p<10000;p++){if(range&&(p+1<range.start||p+1>range.end))continue;sources.push(...chunks("slides",`${f.name} · ${p+1}`,pages[p],`d${i}p${p+1}`));if(sources.length>1600)break;}}
 if(!files.length&&lecture.slidesText)sources.push(...chunks("slides","Slides",lecture.slidesText,"legacy"));
 return sources.slice(0,1800);
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
 const sources=await lectureSources(lid);if(!sources.length)return Response.json({error:"material_not_ready"},{status:409});
 if(!process.env.API_TOKEN||!geminiConfigured())return Response.json({error:"tutor_unavailable"},{status:503});
 try{return Response.json(await runTutor(parsed.data.question,parsed.data.language,sources,tutorJson,parsed.data.previous_questions),{headers:{"Cache-Control":"no-store"}});}
 catch{return Response.json({error:"tutor_unavailable"},{status:503});}
}
