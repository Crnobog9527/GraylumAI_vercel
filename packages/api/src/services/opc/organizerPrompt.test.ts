/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {describe,expect,it} from 'vitest';
import {ORGANIZER_INSTRUCTIONS,organizerStepMaterial} from './organizerPrompt';
import {mentorHost,mentorOrganizerInput,mentorState} from '../turn/mentorContext';
import {mentorSystem,organizerInstructions} from '../turn/mentorPrompt';
const schema=[{id:'goal',title:'目标与变现方式',required:true},
  {id:'audience',title:'服务受众',required:true},{id:'platform',title:'起步平台',required:true}];
const id='10000000-0000-4000-8000-000000000001';
const values={goal:{status:'provisional',nature:'decision',value:'增加工作日下午的到店客流，暂不扩店'},
  audience:{status:'unknown',nature:'unknown',value:''},platform:{status:'deferred',nature:'unknown',value:''}};

describe('organizer complete-value context',()=>{
  it('projects only pinned current-step fields with values and statuses, including missing fields',()=>{
    expect(organizerStepMaterial('current',schema,{...values,foreign:{value:'not in schema'}})).toEqual({id:'current',fields:[
      {id:'goal',title:'目标与变现方式',required:true,elicit:'user_fact',...values.goal},
      {id:'audience',title:'服务受众',required:true,elicit:'user_fact',...values.audience},
      {id:'platform',title:'起步平台',required:true,elicit:'user_fact',...values.platform},
    ]});
    expect(organizerStepMaterial('current',schema,null)).toEqual(organizerStepMaterial('current',schema));
    expect(organizerStepMaterial('current',schema).fields.every(f=>f.value===''&&f.status==='unknown')).toBe(true);
  });
  it.each([
    ['audience answer', '先服务附近独自阅读的自由职业者，给他们安静的空间'],
    ['platform choice', '小红书'],
  ])('freezes existing goal and off-topic %s separately with the complete declared checklist',(_name,input)=>{
    const state=mentorState({draftId:id,projectId:id,roundId:id,mode:'new',moduleId:id,skillId:id,revisionId:id,packageHash:'a'.repeat(64),
      steps:[{id:'current',title:'了解你',information:schema,resources:['SKILL.md']}],suggestions:{},fallbackEligible:false,
      work:{roundId:id,steps:{current:{version:1,valid:false,information:values}}}},'current');
    const host=mentorHost(state,'current',{opening:false,summary:false});
    const frozen=mentorOrganizerInput(state,host,input).value as {userInput:string;captureFormat:string;
      checklist:Array<{fields:Array<{id:string;value:string}>}>};
    expect(frozen.userInput).toBe(input);
    expect(frozen.captureFormat).toBe('v2');
    expect(frozen).not.toHaveProperty('currentQuestion');
    expect(frozen.checklist[0]!.fields.map(f=>f.id)).toEqual(['goal','audience','platform']);
    expect(frozen.checklist[0]!.fields[0]!.value).toBe(values.goal.value);
    expect(organizerInstructions(undefined,false)).toContain('return empty patches');
    expect(mentorSystem({skillText:'',skillEntryChars:0,brandIdentity:false,mode:'new',host,skillFile:false,replyRule:''}).instructions)
      .toContain('Never pull the user back to a numbered question');
  });
  it('requires complete updates, unchanged-content empty patches, and provisional status',()=>{
    expect(ORGANIZER_INSTRUCTIONS).toContain('updated COMPLETE value, preserving valid information');
    expect(ORGANIZER_INSTRUCTIONS).toContain('If there is no substantive change, return empty patches');
    expect(ORGANIZER_INSTRUCTIONS).toContain('only for an explicit correction or contradiction');
    expect(ORGANIZER_INSTRUCTIONS).toContain('Updates remain provisional');
    expect(ORGANIZER_INSTRUCTIONS).toContain('Never return confirmed or deferred');
  });
  it('separates user statements from mentor proposals when merging complete values',()=>{
    expect(ORGANIZER_INSTRUCTIONS).toContain('For user_fact, retain supported user-stated content and add only what the user stated');
    expect(ORGANIZER_INSTRUCTIONS).toContain('Use the mentor reply only to understand context');
    expect(ORGANIZER_INSTRUCTIONS).toContain("never merge the mentor's guesses or recommendations as user facts");
    expect(ORGANIZER_INSTRUCTIONS).toContain('Only an agent_proposal field may adopt a relevant concrete mentor recommendation, with basis agent_proposal');
    expect(ORGANIZER_INSTRUCTIONS).not.toContain('combine its existing supported content with the relevant user answer and the primary mentor reply');
  });
  it('bounds every complete value and preserves qualifications when condensing',()=>{
    expect(ORGANIZER_INSTRUCTIONS).toContain('Each field value must be at most 400 characters');
    expect(ORGANIZER_INSTRUCTIONS).toContain('condense it into concise key points within that limit');
    expect(ORGANIZER_INSTRUCTIONS).toContain('preserving key facts, decisions, negation, constraints and uncertainty');
    expect(ORGANIZER_INSTRUCTIONS).toContain('Do not emit an overlong value that the host would discard');
    expect(ORGANIZER_INSTRUCTIONS).toContain('or drop important qualifications merely to shorten it');
  });

});

it('preserves organizer descriptions without adding them to mentor field specs',async()=>{
 const {elicitFieldSpecs}=await import('../../shared/opcMethodPolicy');
 const fields=[{id:'plan',description:'Only a concrete first-month schedule.'}];
 expect(organizerStepMaterial('later',fields).fields[0]).toHaveProperty('description',fields[0]!.description);
 expect(elicitFieldSpecs(fields)[0]).not.toHaveProperty('description');
});

it('accepts explicit user plans in proposal fields without relaxing source or event isolation',()=>{
 expect(ORGANIZER_INSTRUCTIONS).toContain('default collection method, not a restriction');
 expect(ORGANIZER_INSTRUCTIONS).toContain('explicit user statement or explicit adoption of a specific proposal');
 expect(ORGANIZER_INSTRUCTIONS).toContain('can update that field with basis user_statement');
 expect(ORGANIZER_INSTRUCTIONS).toContain('bare acknowledgement, request or ambiguous reference is not adoption');
 expect(ORGANIZER_INSTRUCTIONS).toContain('Keep user plans as plans or decisions, not completed facts');
 expect(ORGANIZER_INSTRUCTIONS).toContain('Do not redirect a later-step plan into a current-step field');
 expect(ORGANIZER_INSTRUCTIONS).toContain('Never extract user_fact fields, user_statement patches or the host marker for that event');
 expect(ORGANIZER_INSTRUCTIONS).not.toContain('only a relevant concrete mentor recommendation can update that field');
});
