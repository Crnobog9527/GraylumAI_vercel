/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { createStreamingOutput } from '../streamingOutput';

describe('checked incremental output',()=>{
  it('releases checked prefixes before the complete answer and retains a tail',()=>{
    const sent:string[]=[];const push=createStreamingOutput(true,v=>sent.push(v));
    const answer='这是可以逐步显示的公开内容。'.repeat(30);
    for(let i=1;i<=answer.length;i++)push(answer.slice(0,i));
    expect(sent.length).toBeGreaterThan(2);expect(answer.startsWith(sent.at(-1)!)).toBe(true);
    expect(sent.at(-1)!.length).toBeLessThan(answer.length-127);
  });
  it.each(['alice@example.com','1234 5678 9012 3456','sk-'+ 'a'.repeat(60),'eyJ'+ 'a'.repeat(160)+'.eyJbbbb.cccccc','password: '+ 'x'.repeat(40),'api_key = '+ 'z'.repeat(40)])('retains split sensitive material until full checking: %s',secret=>{
    const prefix='Ordinary public text. '.repeat(15),answer=prefix+secret+' '+ 'afterwards '.repeat(30);
    const sent:string[]=[];const push=createStreamingOutput(true,v=>sent.push(v));
    for(let i=1;i<=answer.length;i++)push(answer.slice(0,i));
    expect(sent.every(v=>!v.includes(secret))).toBe(true);
    expect(sent.every(v=>!v.includes(secret.slice(0,Math.min(secret.length,12))))).toBe(true);
  });
  it('never previews private-method generations',()=>{const sent:string[]=[];createStreamingOutput(false,v=>sent.push(v))('METHOD_CANARY '.repeat(100));expect(sent).toEqual([]);});
});
