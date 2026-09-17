/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {expect,it} from "vitest";
import {confirmQuestionValues,displayedQuestion,emptyAnswer,nextInformationQuestion,reachedQuestions,type QuestionAnswer} from "./questions";
const schema=[{id:"lane",title:"赛道",required:true},{id:"offer",title:"商业卖点",required:true},{id:"extra",title:"补充",required:false}];
it("starts from the first question when persisted values are null",()=>{
 expect(displayedQuestion(schema,null)?.id).toBe("lane");
 expect(reachedQuestions(schema,null).map(f=>f.id)).toEqual(["lane"]);
});
it("typing or a suggestion cannot confirm or expose future questions",()=>{
 for(const status of ["unknown","unclear","provisional"] as const){
  const values={lane:{...emptyAnswer,value:"AI",status}};
  expect(nextInformationQuestion(schema,values)?.id).toBe("lane");
  expect(reachedQuestions(schema,values).map(f=>f.id)).toEqual(["lane"]);
  expect(displayedQuestion(schema,values,"offer")?.id).toBe("lane");
 }
});
it("confirms one field only and preserves every other answer",()=>{
 const values={lane:{...emptyAnswer,value:"AI",status:"provisional" as const},offer:{...emptyAnswer,value:"Still thinking"}};
 const first=confirmQuestionValues(schema,values,"lane");
 expect(first.finishStep).toBe(false);expect(first.values.offer).toEqual(values.offer);expect(values.lane.status).toBe("provisional");
 expect(nextInformationQuestion(schema,first.values)?.id).toBe("offer");
 expect(reachedQuestions(schema,first.values).map(f=>f.id)).toEqual(["lane","offer"]);
 expect(displayedQuestion(schema,first.values,"lane")?.id).toBe("lane");
 expect(()=>confirmQuestionValues(schema,values,"extra")).toThrow("NOT_REACHED");
});
it("requires a reason for required deferral and explicit optional skip",()=>{
 expect(()=>confirmQuestionValues(schema,{},"lane",true)).toThrow("ANSWER_REQUIRED");
 const first=confirmQuestionValues(schema,{lane:{...emptyAnswer,value:"尚缺案例，接受局限"}},"lane",true);
 const second=confirmQuestionValues(schema,{...first.values,offer:{...emptyAnswer,value:"摄影课程"}},"offer");
 expect(second.finishStep).toBe(false);
 const last=confirmQuestionValues(schema,second.values,"extra",true);
 expect(last.finishStep).toBe(true);expect(nextInformationQuestion(schema,last.values)).toBeUndefined();
});
it("editing a previous answer reopens it without deleting later saved answers",()=>{
 const values:Record<string,QuestionAnswer>=Object.fromEntries(schema.map(f=>[f.id,{...emptyAnswer,value:f.title,status:"confirmed"}]));
 values.lane={...values.lane,status:"provisional"};expect(nextInformationQuestion(schema,values)?.id).toBe("lane");
 expect(confirmQuestionValues(schema,values,"lane").values.offer).toEqual(values.offer);
});
