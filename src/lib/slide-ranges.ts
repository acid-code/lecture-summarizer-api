/** Original 1-based page coordinates; an approximate range is user-approved focus, not fact. */
export interface SlideRange { start:number; end:number; approximate:boolean }
export function parseSlideRange(params:URLSearchParams):SlideRange|null {
  const a=params.get("slide_start"), b=params.get("slide_end");
  if(a===null && b===null)return null;
  if(!a || !b || !/^\d+$/.test(a) || !/^\d+$/.test(b))throw new Error("invalid_slide_range");
  const start=Number(a),end=Number(b);const approx=params.get("approximate");
  if(start<1 || end<start || end>10000 || approx!==null && !["true","false"].includes(approx))throw new Error("invalid_slide_range");
  return {start,end,approximate:approx!=="false"};
}
export function storedSlideRange(raw:string|null|undefined):SlideRange|null {
  if(!raw)return null;try{const x=JSON.parse(raw);return parseSlideRange(new URLSearchParams({slide_start:String(x.start),slide_end:String(x.end),approximate:String(x.approximate!==false)}));}catch{return null;}
}
export function focusedDeckText(name:string,text:string|null,range:SlideRange|null):string {
  if(!text)return "";
  if(!range)return text;
  const pages=text.split("\f");
  if(range.end>pages.length)throw new Error("slide_range_exceeds_pages");
  return `FOCUS: original slides ${range.start}-${range.end}${range.approximate?" (approximate; transcript is authoritative)":""}\n`+
    pages.slice(range.start-1,range.end).map((page,i)=>`[${name.replace(/[\r\n]/g," ").slice(0,180)}; slide ${range.start+i}]\n${page}`).join("\f");
}
export function combineDeckText(files:{name:string;text:string|null;slideRange?:string|null}[]):string|null {
  return files.filter(f=>f.text).map(f=>`=== ${f.name.replace(/[\r\n]/g," ").slice(0,180)} ===\n${focusedDeckText(f.name,f.text,storedSlideRange(f.slideRange))}`).join("\f") || null;
}
export function pageInRange(page:number,range?:SlideRange|null){return !range || page>=range.start && page<=range.end;}
