import {before,test} from "node:test";
import assert from "node:assert/strict";
process.env.DATABASE_URL=`file:/tmp/ls-move-${process.pid}.db`;process.env.API_TOKEN="test-token";
let route:any,db:any,schema:any,source:string,target:string,foreign:string,lid:string;
async function call(path:string,device:string|null,body:unknown){const r=await route(new Request(`http://local/v1/${path}`,{method:"POST",headers:{authorization:"Bearer test-token","content-type":"application/json",...(device?{"x-device-id":device}:{})},body:JSON.stringify(body)}),{params:Promise.resolve({path:path.split("/")})});return {status:r.status,body:await r.json()};}
before(async()=>{route=(await import("../src/app/v1/[...path]/route")).POST;({db,schema}=await import("../src/db"));
 source=(await call("courses","device-move-A",{name:"Source"})).body.course_id;
 target=(await call("courses","device-move-A",{name:"Destination"})).body.course_id;
 foreign=(await call("courses","device-move-B",{name:"Foreign"})).body.course_id;
 lid=(await call("lectures","device-move-A",{course_id:source,title:"A real lecture"})).body.lecture_id;
 await db.insert(schema.jobs).values({id:"preserved-job",lectureId:lid,stage:"done",updatedAt:1,artifacts:JSON.stringify({summary:{overview:"preserved"},pdf:"local:pdf",asr:{segments:[{text:"preserved transcript"}]}})});
 await db.insert(schema.lectureFiles).values({id:"preserved-deck",lectureId:lid,kind:"slides",name:"Deck 2",mime:"application/pdf",url:"local:deck",text:"preserved slides",createdAt:1});
});
test("move requires a device and both courses must belong to it",async()=>{
 assert.equal((await call(`lectures/${lid}/move`,null,{course_id:target})).status,401);
 assert.equal((await call(`lectures/${lid}/move`,"device-move-B",{course_id:foreign})).status,404);
 assert.equal((await call(`lectures/${lid}/move`,"device-move-A",{course_id:foreign})).status,404);
 assert.equal((await call(`lectures/${lid}/move`,"device-move-A",{course_id:"missing"})).status,404);
 assert.equal((await call(`lectures/${lid}/move`,"device-move-A",{course_id:target,slides:[]})).status,400);
});
test("moving changes only course_id and preserves summaries, transcript, slides and lecture identity",async()=>{
 const before=await db.query.lectures.findFirst();const jobs=await db.query.jobs.findMany();const files=await db.query.lectureFiles.findMany();
 const r=await call(`lectures/${lid}/move`,"device-move-A",{course_id:target});assert.equal(r.status,200);assert.equal(r.body.lecture_id,lid);
 const after=await db.query.lectures.findFirst();assert.deepEqual(after,{...before,courseId:target});assert.deepEqual(await db.query.jobs.findMany(),jobs);assert.deepEqual(await db.query.lectureFiles.findMany(),files);
 assert.equal((await call(`lectures/${lid}/move`,"device-move-A",{course_id:target})).status,200);
});

test("newer failed summary is not hidden by an older still-running job",async()=>{
 await db.insert(schema.jobs).values([{id:"older-running",lectureId:lid,stage:"pdf",updatedAt:2,artifacts:JSON.stringify({options:{density:"compact"}})},{id:"newer-failed",lectureId:lid,stage:"failed",updatedAt:3,artifacts:JSON.stringify({options:{density:"compact"}})}]);
 const r=await route(new Request(`http://local/v1/lectures/${lid}/summaries`,{headers:{authorization:"Bearer test-token","x-device-id":"device-move-A"}}),{params:Promise.resolve({path:["lectures",lid,"summaries"]})});
 const body=await r.json();assert.equal(body.densities.compact.running_job_id,null);assert.equal(body.densities.compact.failed_job_id,"newer-failed");
});
