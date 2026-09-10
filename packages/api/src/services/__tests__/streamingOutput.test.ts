/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { createStreamingOutput } from '../streamingOutput';

describe('checked incremental output',()=>{
  it('releases checked prefixes before the complete answer and retains a tail',()=>{
    const sent:string[]=[];const push=createStreamingOutput(true,v=>sent.push(v));
    const answer='这是可以逐步显示的公开内容。'.repeat(30);
    for(let i=1;i<=answer.length;i++)push(answer.slice(0,i));
    expect(sent.length).toBeGreaterThan(2);expect(answer.startsWith(sent.join(''))).toBe(true);
    expect(sent.join('').length).toBeLessThan(answer.length-127);
  });
  it.each(['alice@example.com','1234 5678 9012 3456','sk-'+ 'a'.repeat(60),'eyJ'+ 'a'.repeat(160)+'.eyJbbbb.cccccc','password: '+ 'x'.repeat(40),'api_key = '+ 'z'.repeat(40)])('retains split sensitive material until full checking: %s',secret=>{
    const prefix='Ordinary public text. '.repeat(15),answer=prefix+secret+' '+ 'afterwards '.repeat(30);
    const sent:string[]=[];const push=createStreamingOutput(true,v=>sent.push(v));
    for(let i=1;i<=answer.length;i++)push(answer.slice(0,i));
    expect(!sent.join('').includes(secret)).toBe(true);
    expect(!sent.join('').includes(secret.slice(0,Math.min(secret.length,12)))).toBe(true);
  });
  it('never previews private-method generations',()=>{const sent:string[]=[];createStreamingOutput(false,v=>sent.push(v))('METHOD_CANARY '.repeat(100));expect(sent).toEqual([]);});
});

it('transfers checked 8/16/32 KiB answers linearly including actual SSE framing and final replacement',()=>{
  const sizes=[8192,16384,32768],bytes:number[]=[];
  for(const size of sizes){
    const answer='Public safe text. '.repeat(Math.ceil(size/18)).slice(0,size);
    const events:Array<{type:string;requestId:string;content:string;final?:boolean}>=[];
    const push=createStreamingOutput(true,content=>events.push({type:'content',requestId:'11111111-1111-4111-8111-111111111111',content}));
    for(let i=64;i<answer.length;i+=64)push(answer.slice(0,i));push(answer);
    const preview=events.map(v=>v.content).join('');
    const wire=events.map(v=>'data: '+JSON.stringify(v)+'\n\n').join('')+'data: '+JSON.stringify({type:'content',requestId:'11111111-1111-4111-8111-111111111111',content:answer,final:true})+'\n\n';
    bytes.push(Buffer.byteLength(wire));
    expect.soft(answer.startsWith(preview)).toBe(true);expect.soft(preview.length).toBeGreaterThan(size-256);
    expect.soft(Buffer.byteLength(wire)).toBeLessThan(size*4);
  }
  console.log('STREAM_WIRE_BYTES',JSON.stringify({sizes,bytes}));
  expect(bytes[1]/bytes[0]).toBeLessThan(2.1);expect(bytes[2]/bytes[1]).toBeLessThan(2.1);
});
