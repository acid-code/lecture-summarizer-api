import { test } from "node:test";
import assert from "node:assert/strict";

// This test exercises the REAL SDK + shared retry ladder with a closed local fetch stub.
// These strings are dummy fixtures, not service credentials. No real model request is possible.
process.env.DATABASE_URL=`file:/tmp/ls-tutor-sdk-${process.pid}.db`;
process.env.GEMINI_API_KEY="fixture-rejected-key";
process.env.GEMINI_API_KEYS="fixture-working-key";
process.env.GEMINI_MODEL="fixture-model";
process.env.GEMINI_FALLBACK_MODELS="";

test("tutor uses strict system instructions and the shared multi-key failover",async()=>{
 const original=globalThis.fetch;const keys:string[]=[];
 globalThis.fetch=async(input,init)=>{
   const url=String(input instanceof Request?input.url:input);assert.match(url,/generativelanguage.*generateContent/);
   const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
   const key=headers.get("x-goog-api-key")??"";keys.push(key);
   const body=JSON.parse(String(init?.body));
   assert.equal(body.systemInstruction.parts[0].text,"Strict fixture tutor system rule");
   assert.equal(body.generationConfig.responseMimeType,"application/json");assert.ok(!body.tools);
   assert.deepEqual(JSON.parse(body.contents[0].parts[0].text),{question:"enzyme"});
   if(key==="fixture-rejected-key")return new Response(JSON.stringify({error:{code:400,message:"API key not valid. Please pass a valid API key.",status:"INVALID_ARGUMENT"}}),{status:400,headers:{"content-type":"application/json"}});
   assert.equal(key,"fixture-working-key");
   return new Response(JSON.stringify({candidates:[{content:{role:"model",parts:[{text:'{"ok":true}'}]},finishReason:"STOP"}]}),{headers:{"content-type":"application/json"}});
 };
 try{const {tutorJson}=await import("../src/lib/providers/gemini");assert.deepEqual(await tutorJson("Strict fixture tutor system rule",{question:"enzyme"}),{ok:true});assert.deepEqual(keys,["fixture-rejected-key","fixture-working-key"]);}finally{globalThis.fetch=original;}
});
