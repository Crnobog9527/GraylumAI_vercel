/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {runtimeAdmissionService} from './admission';
import {REPLY_LANGUAGE,REPLY_LANGUAGE_INSTRUCTIONS,withPrimaryAddenda} from './primaryInstructions';
import {REPLY_LANGUAGE_SETTINGS,frozenReplyRule,replySettingInstructions} from './replyLanguage';
import {runtimeContext} from './runtimeContext';
import {effectiveReplyLocale,entryLocaleHint,REPLY_LOCALES} from '../../shared/replyLanguage';
vi.mock('../redisRateLimiter', () => ({ checkRuntimeRateLimit: async () => ({ success: true }) }));
vi.mock('./automaticRecovery', () => ({ runAutomaticFinancialRecovery: async () => ({ failed: 0 }) }));
vi.mock('./billingUnitAdmission', async (original) => ({
  ...(await original<typeof import('./billingUnitAdmission')>()),
  freezeWindowBillingUnit: async () => ({ version: 'bill-unit-v2', creditsPerUsd: '1000', defaultMultiplier: '1', models: {}, providers: {}, hash: 'f'.repeat(64) }),
}));
const actor='10000000-0000-4000-8000-000000000001',sessionId='10000000-0000-4000-8000-000000000002';
const modelId='10000000-0000-4000-8000-000000000003',requestId='10000000-0000-4000-8000-000000000004';
const NAMES={'zh-Hans':'Simplified Chinese','zh-Hant':'Traditional Chinese (Taiwan usage)',en:'English'} as const;

describe('the reply-language rule', () => {
  it.each(REPLY_LOCALES)('names %s, wins over the Skill and lets an explicit request win for what was asked', locale => {
    const text=replySettingInstructions(locale);
    expect(text).toContain(`the user set their language to ${NAMES[locale]}.`);
    expect(text).toContain('takes precedence over any language rule in the Skill');
    expect(text).toContain("whatever language the Skill, the material or the user's messages are written in");
    expect(text).toContain('Only when the user explicitly asks for another language');
    expect(text).toContain('keep everything else in the set language');
    // v3 (2026-10-25): what the reply creates is in the set language too, unless the user names the audience's language.
    expect(text).toContain(`Write everything in ${NAMES[locale]}: the reply itself and everything it creates, such as titles, names, examples, scripts and copy`);
    expect(text).toContain('or explicitly says which language their audience uses');
    for(const other of REPLY_LOCALES.filter(item=>item!==locale))expect(text).not.toContain(`language to ${NAMES[other]}.`);
  });
  it.each(REPLY_LOCALES)('a frozen %s value appends exactly its own rule, and the context schema accepts it', locale => {
    const value=REPLY_LANGUAGE_SETTINGS[locale];
    expect(value).toBe(`reply-language-v3-${locale}`);
    expect(frozenReplyRule(value)).toBe(replySettingInstructions(locale));
    expect(withPrimaryAddenda('Skill 正文',{replyLanguage:value})).toBe('Skill 正文'+replySettingInstructions(locale));
    expect(runtimeContext.shape.replyLanguage.parse(value)).toBe(value);
  });
  it('executions frozen with the v2 wording replay it byte-identical (2026-10-24 text, pinned)', () => {
    const v2=(name:string)=>`\nReply language (host rule, takes precedence over any language rule in the Skill): the user set their language to `+
      `${name}. Write replies, questions, card options, drafts and reports in ${name}, whatever language the Skill, the material or `+
      'the user\'s messages are written in. Only when the user explicitly asks for another language (for example "write an English '+
      'version" or "用英文回答"), write what they asked for in that language, and keep everything else in the set language. Keep '+
      'required exact strings (report headings, ids, JSON keys) unchanged.';
    for(const locale of REPLY_LOCALES){
      const value=`reply-language-v2-${locale}`;
      expect(withPrimaryAddenda('base',{replyLanguage:value})).toBe('base'+v2(NAMES[locale]));
      expect(runtimeContext.shape.replyLanguage.parse(value)).toBe(value);
    }
  });
  it('executions admitted before the setting replay their own rule byte-identical; unknown values add nothing', () => {
    expect(withPrimaryAddenda('base',{replyLanguage:REPLY_LANGUAGE})).toBe('base'+REPLY_LANGUAGE_INSTRUCTIONS);
    for(const value of [undefined,'reply-language-v2','reply-language-v3','reply-language-v3-fr','toString','__proto__'])
      expect(withPrimaryAddenda('base',{replyLanguage:value})).toBe('base');
    expect(()=>runtimeContext.shape.replyLanguage.parse('reply-language-v2-fr')).toThrow();
  });
  it('no stored value (or an unknown one) means Simplified Chinese; any of the three languages is an entry hint', () => {
    expect([null,undefined,'',"fr",'zh-hant'].map(effectiveReplyLocale)).toEqual(Array(5).fill('zh-Hans'));
    expect(effectiveReplyLocale('en')).toBe('en');
    expect([entryLocaleHint('zh-Hant'),entryLocaleHint('en'),entryLocaleHint('zh-Hans'),entryLocaleHint('x'),entryLocaleHint(null)])
      .toEqual(['zh-Hant','en','zh-Hans',null,null]);
  });
});

function fixture(profile:{reply_language?:string|null}|{error:{code:string;message:string}},opts:{inputBytes?:number;replay?:unknown}={}){
  let frozen:Record<string,unknown>|undefined;
  const tables:string[]=[];
  const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
    if(name==='runtime_session_context')return {data:{scope:{kind:'positioning_draft',draftId:sessionId}},error:null};
    if(name==='runtime_admission_replay')return {data:opts.replay??null,error:null};
    if(name==='runtime_admit'){frozen=args.p_payload as Record<string,unknown>;return {data:{executionId:requestId},error:null};}
    throw new Error(name);
  });
  const model={id:modelId,model_id:'fixture',provider:'fixture',is_active:'true',max_tokens:1000,input_limit:32000};
  const admin={rpc,from:(table:string)=>{
    tables.push(table);
    const q={select:()=>q,eq:()=>q,in:async()=>({data:[],error:null}),
      single:async()=>table==='profiles'?('error' in profile?{data:null,error:profile.error}:{data:profile,error:null}):{data:model,error:null}};
    return q;
  }} as unknown as SupabaseClient;
  const user={auth:{getUser:async()=>({data:{user:{id:actor,email_confirmed_at:'2026-01-01T00:00:00Z'}},error:null})}} as unknown as SupabaseClient;
  const service=runtimeAdmissionService(user,admin,{account:'test',costPerCall:'0.02',creditsPerUsd:'1000',multiplier:'1',maxCalls:3,
    maxOutputTokens:1000,inputBytes:opts.inputBytes??32000,historyItems:10});
  const prepare=(input='帮我写一条关于咖啡的小红书')=>service.prepare({sessionId,requestId,input,selection:{kind:'ordinary',modelId},network:'deny'});
  return {prepare,tables,frozen:()=>frozen};
}

describe('admission freezes the profile language', () => {
  it.each([['zh-Hans','zh-Hans'],['zh-Hant','zh-Hant'],['en','en'],[null,'zh-Hans']] as const)
  ('profile %s → %s, and the executor appends that rule', async (stored,locale) => {
    const f=fixture({reply_language:stored});
    await f.prepare();
    const frozen=f.frozen()!;
    expect(frozen.replyLanguage).toBe(REPLY_LANGUAGE_SETTINGS[locale]);
    expect(withPrimaryAddenda(String(frozen.instructions),frozen as never).endsWith(replySettingInstructions(locale))).toBe(true);
  });
  it('a retried request replays its frozen payload without reading the (since changed) setting', async () => {
    const first=fixture({reply_language:'zh-Hant'});
    await first.prepare();
    const stored={executionId:requestId,payload:first.frozen()};
    const again=fixture({reply_language:'en'},{replay:stored});
    expect(await again.prepare()).toEqual(stored);
    expect(again.tables).not.toContain('profiles');
    expect(again.frozen()).toBeUndefined();
    expect(withPrimaryAddenda('x',stored.payload as never)).toBe(withPrimaryAddenda('x',first.frozen() as never));
  });
  it('an unreadable profile refuses the turn instead of guessing a language', async () => {
    const f=fixture({error:{code:'08006',message:'synthetic'}});
    await expect(f.prepare()).rejects.toThrow();
    expect(f.frozen()).toBeUndefined();
  });
  it('the rule counts toward capacity: the longer rule needs exactly its extra bytes', async () => {
    const admits=async(locale:string,inputBytes:number)=>fixture({reply_language:locale},{inputBytes}).prepare().then(()=>true,()=>false);
    // The smallest input capacity that admits the English rule (binary search; 32000 admits, as the tests above show).
    let low=0,high=32000;
    while(high-low>1){const mid=Math.floor((low+high)/2);if(await admits('en',mid))high=mid;else low=mid;}
    const edge=high;
    const extra=Buffer.byteLength(replySettingInstructions('zh-Hant'))-Buffer.byteLength(replySettingInstructions('en'));
    expect(extra).toBe(2*(NAMES['zh-Hant'].length-NAMES.en.length));
    expect(await admits('en',edge-1)).toBe(false);
    expect(await admits('zh-Hant',edge+extra-1)).toBe(false);
    expect(await admits('zh-Hant',edge+extra)).toBe(true);
  });
});
