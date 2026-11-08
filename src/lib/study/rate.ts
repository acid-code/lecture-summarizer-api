import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
const bounded=(value:string|undefined,fallback:number,max:number)=>Math.max(1,Math.min(max,Number(value)||fallback));
/** Atomic persisted UPSERT, shared across workers and cold starts. No lecture content in this table. */
export async function tutorLimit(deviceId:string,now=Date.now()):Promise<number|null>{
 const dev=createHash("sha256").update(deviceId).digest("hex");
 for(const [ms,limit] of [[60000,bounded(process.env.TUTOR_PER_MINUTE,6,60)],[86400000,bounded(process.env.TUTOR_PER_DAY,60,1000)]]){
   const start=Math.floor(now/ms)*ms,expires=start+ms;
   const key=`${dev}:${ms}:${start}`;
   const r=await db.run(sql`INSERT INTO tutor_buckets (bucket_key,hits,expires_at) VALUES (${key},1,${expires}) ON CONFLICT(bucket_key) DO UPDATE SET hits=hits+1 WHERE hits<${limit} RETURNING hits`);
   if(!r.rows.length)return Math.max(1,Math.ceil((expires-now)/1000));
 }
 await db.run(sql`DELETE FROM tutor_buckets WHERE expires_at<${now-86400000}`);
 return null;
}
