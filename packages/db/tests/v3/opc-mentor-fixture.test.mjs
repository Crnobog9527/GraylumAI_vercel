import {it} from "node:test";
import assert from "node:assert/strict";
import {mentorQuestionFixture} from "./opc-mentor-fixture.mjs";
const instructions='Allowed field IDs for the current step: ["offer"].\nCurrent information question: {"id":"offer","title":"可持续内容与商业卖点"}';
it("targets the active second question, not the first field",()=>{
 const r=mentorQuestionFixture(instructions,"我可以持续分享摄影经验",0);
 assert.deepEqual(Object.keys(r.informationPatch),["offer"]);assert.match(r.message,/可持续内容与商业卖点/);assert.equal(r.informationPatch.offer.status,"provisional");
});
it("uncertainty stays on the same question without replacing a saved value",()=>{
 for(const input of ["不知道","不知道呢","我还不确定","没想好","I don't know","idk"]){const r=mentorQuestionFixture(instructions,input,0);assert.deepEqual(r.informationPatch,{});assert.match(r.message,/一项经验/);}
});
it("preserves explicitly requested cross-step revision as a separate proposal",()=>{
 const r=mentorQuestionFixture(instructions,"模拟：修改第一步目标",1);assert.equal(r.targetStepId,"step-0");assert.deepEqual(Object.keys(r.informationPatch),["goal"]);
});
