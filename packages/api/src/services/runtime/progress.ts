/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export type RuntimeProgress={type:'text';text:string}|{type:'phase';phase:'mentor'|'organizer'|'saving'};
/** Only the leading public message string of the OPC JSON protocol may leave
 * the server. Partial escapes wait for the next provider chunk. Never forward
 * raw JSON, reasoning, provider metadata or later structured fields. */
export function publicMentorText(raw:string):string {
 const start=/^\s*\{\s*"message"\s*:\s*"/.exec(raw);if(!start)return '';
 let encoded='';
 for(let i=start[0].length;i<raw.length;i++){
  const c=raw[i]!;if(c==='"')break;
  if(c==='\\'){
   const next=raw[i+1];if(next===undefined)break;
   if(next==='u'){if(i+5>=raw.length)break;const hex=raw.slice(i+2,i+6);if(!/^[0-9a-f]{4}$/i.test(hex))return '';encoded+=raw.slice(i,i+6);i+=5;}
   else {if(!'"\\/bfnrt'.includes(next))return '';encoded+=c+next;i++;}
  }else{if(c.charCodeAt(0)<32)return '';encoded+=c;}
 }
 try{return (JSON.parse('"'+encoded+'"') as string).trimStart().slice(0,4000);}catch{return '';}
}
