import {before,test} from "node:test";
import assert from "node:assert/strict";
import {rmSync} from "node:fs";
import {zipSync,strToU8} from "fflate";
import {eq} from "drizzle-orm";
import {parseSlideRange,focusedDeckText,combineDeckText,pageInRange} from "../src/lib/slide-ranges";
import {slidesForSummary} from "../src/lib/providers/prompts";
const file=`/tmp/deck-continuation-${process.pid}.db`;rmSync(file,{force:true});
process.env.DATABASE_URL=`file:${file}`;process.env.API_TOKEN="continuation-fixture-token";process.env.AI_PROVIDER="mock";process.env.PDF_RENDERER="html";
delete process.env.BLOB_READ_WRITE_TOKEN;delete process.env.GEMINI_API_KEY;
let route:typeof import("../src/app/v1/[...path]/route").GET;
before(async()=>{route=(await import("../src/app/v1/[...path]/route")).GET});
async function call(method:string,path:string,body?:unknown,device="continuation-owner"){
 const multipart=body instanceof FormData;
 const response=await route(new Request(`http://test/v1/${path}`,{method,headers:{authorization:"Bearer continuation-fixture-token","x-device-id":device,...(multipart?{}:{"content-type":"application/json"})},body:body===undefined?undefined:multipart?body:JSON.stringify(body)}),{params:Promise.resolve({path:path.split("?")[0].split("/")})});
 return {status:response.status,data:await response.json() as any};
}
function deck(prefix:string){return zipSync(Object.fromEntries([1,2,3,4].map(n=>[`ppt/slides/slide${n}.xml`,strToU8(`<p:sld><a:p><a:r><a:t>${prefix}PAGE${n} specific scientific evidence</a:t></a:r></a:p></p:sld>`)])));}
async function upload(id:string,name:string,range=""){
 const form=new FormData();form.append("file",new File([deck(name)],name,{type:"application/vnd.openxmlformats-officedocument.presentationml.presentation"}));return call("POST",`lectures/${id}/slides${range}`,form);
}
test("same deck can belong to two lectures; both decks and focused original pages reach summary context",async()=>{
 const c=await call("POST","courses",{name:"Continuation fixture"});const one=await call("POST","lectures",{course_id:c.data.course_id,title:"Lecture 3"});const two=await call("POST","lectures",{course_id:c.data.course_id,title:"Lecture 4"});const a=one.data.lecture_id,b=two.data.lecture_id;
 assert.equal((await upload(a,"Slides2.pptx")).status,200);
 assert.equal((await upload(a,"Slides2.pptx")).status,200);assert.equal((await call("GET",`lectures/${a}/files`)).data.length,1);
 assert.equal((await upload(b,"Slides2.pptx","?replace=all&slide_start=3&slide_end=4&approximate=true")).status,200);
 assert.equal((await upload(b,"Slides3.pptx","?slide_start=1&slide_end=2&approximate=true")).status,200);
 const {db,schema}=await import("../src/db");const [stored]=await db.select().from(schema.lectures).where(eq(schema.lectures.id,b));
 assert.ok(stored.slidesText?.includes("Slides2.pptxPAGE3"));assert.ok(stored.slidesText?.includes("Slides3.pptxPAGE2"));assert.ok(!stored.slidesText?.includes("Slides2.pptxPAGE1"));assert.ok(!stored.slidesText?.includes("Slides3.pptxPAGE4"));
 assert.ok(stored.slidesText?.includes("slide 3]"));assert.ok(slidesForSummary(stored.slidesText).includes("Slides3.pptx"));
 const [first]=await db.select().from(schema.lectures).where(eq(schema.lectures.id,a));assert.ok(first.slidesText?.includes("Slides2.pptxPAGE1"));assert.ok(first.slidesText?.includes("Slides2.pptxPAGE4"));
 const capabilities=await call("GET",`lectures/${b}/slides`);assert.equal(capabilities.data.range_support,true);assert.equal(capabilities.data.files.length,2);assert.deepEqual(capabilities.data.files[0].slide_range,{start:3,end:4,approximate:true});
 assert.equal((await call("GET",`lectures/${b}/slides`,undefined,"different-device")).status,404);
 assert.equal((await upload(b,"Slides2.pptx","?slide_start=0&slide_end=2")).status,400);assert.equal((await upload(b,"Slides2.pptx","?slide_start=2&slide_end=99")).status,400);
 assert.equal((await call("GET",`lectures/${b}/files`)).data.length,2);
 assert.equal((await upload(b,"Slides2.pptx","?slide_start=2&slide_end=3&approximate=false")).status,200);const updated=(await call("GET",`lectures/${b}/files`)).data;assert.equal(updated.length,2);assert.deepEqual(updated.map((f:any)=>f.name),["Slides2.pptx","Slides3.pptx"]);assert.equal(updated[0].slide_range.start,2);
 await call("DELETE",`lectures/${b}/slides`);assert.equal((await call("GET",`lectures/${a}/files`)).data.length,1);
});
test("every deck retains prompt budget, including a long middle deck",()=>{
 const sources=["FIRST","MIDDLE","LAST"].map(name=>({name,text:`${name}HEAD `+"biology ".repeat(4000)+`${name}TAIL`}));const prompt=slidesForSummary(combineDeckText(sources));for(const f of sources){assert.ok(prompt.includes(f.name+"HEAD"));assert.ok(prompt.includes(f.name+"TAIL"));}
});
test("ranges validate, preserve original slide numbers and filter PDF/PPTX figure candidates",()=>{
 assert.throws(()=>parseSlideRange(new URLSearchParams("slide_start=2")));assert.throws(()=>parseSlideRange(new URLSearchParams("slide_start=4&slide_end=2")));assert.throws(()=>parseSlideRange(new URLSearchParams("slide_start=1&slide_end=2&approximate=no")));
 const range={start:2,end:3,approximate:true};assert.equal(pageInRange(1,range),false);assert.equal(pageInRange(2,range),true);assert.equal(pageInRange(4,range),false);assert.match(focusedDeckText("Deck","one\ftwo\fthree",range),/slide 2/);assert.throws(()=>focusedDeckText("Deck","one",range));
});
