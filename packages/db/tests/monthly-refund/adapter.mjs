/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import assert from 'node:assert/strict';
// Test transport only: real SQL, parameter-bound values, fixed identifier grammar.
const id = value => { assert.match(value,/^[a-z_][a-z_0-9]*$/);return '"'+value+'"'; };
const col = value => {
 const parts=value.split(/(->>|->)/);let text=id(parts.shift());
 while(parts.length){const op=parts.shift(),key=parts.shift();assert.match(key,/^[A-Za-z_][A-Za-z_0-9]*$/);text+=op+"'"+key+"'";}
 return text;
};
export function transport(client) {
 return {
  async rpc(name,args){
   try {const result=await client.query(`select public.${id(name)}(${Object.keys(args).map((k,n)=>id(k)+'=> $'+(n+1)).join(',')}) data`,Object.values(args));
    return {data:result.rows[0].data,error:null};}catch(error){return {data:null,error};}
  },
  from(table){
   const filters=[],values=[];let selected='id',offset=0,limit=2001,single=false;
   const run=async()=>{
    try {
     const selection=selected.split(',').map(value=>{
      const raw=value.trim();
      const [alias,path]=raw.includes(':')?raw.split(':'):[raw,raw];return col(path)+' as '+id(alias);
     }).join(',');
     const result=await client.query(`select row_to_json(t) row from (select ${selection} from public.${id(table)} ${filters.length?'where '+filters.join(' and '):''}) t`,values);
     const rows=result.rows.map(r=>r.row).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
     const data=rows.slice(offset,offset+limit);
     return {data:single?data[0]??null:data,count:rows.length,error:null};
    }catch(error){return {data:null,count:null,error};}
   };
   const q={select(value){selected=value;return q;},
    eq(key,value){values.push(value);filters.push(col(key)+'=$'+values.length);return q;},
    in(key,value){values.push(value);filters.push(col(key)+'=ANY($'+values.length+')');return q;},
    order(){return q;},range(a,b){offset=a;limit=b-a+1;return q;},limit(n){limit=n;return q;},
    single(){single=true;return q;},maybeSingle(){single=true;return q;},then(resolve,reject){return run().then(resolve,reject);}};
   return q;
  },
 };
}
