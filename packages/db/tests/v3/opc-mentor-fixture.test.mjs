import {it} from "node:test";
import assert from "node:assert/strict";
import {mentorQuestionFixture} from "./opc-mentor-fixture.mjs";
const instructions='Allowed field IDs for the current step: ["offer"].\nCurrent information question: {"id":"offer","title":"可持续内容与商业卖点"}';
const proposalInstructions='Field roles for the current question: [{"id":"position","title":"一句话核心商业定位","required":true,"elicit":"agent_proposal"}]. \nCurrent information question: {"id":"position","title":"一句话核心商业定位"}';
const labelledInstructions='Allowed field IDs for the current step: ["offer"].\nCurrent information question: {"id":"offer","title":"可持续内容与商业卖点","label":"1.2"}';
const laterStepInstructions='Allowed field IDs for the current step: ["offer"].\nCurrent information question: {"id":"offer","title":"可持续内容与商业卖点","label":"3.4"}';
it("uses the host-provided question label verbatim instead of the step index",()=>{
 const asked=mentorQuestionFixture(labelledInstructions,"HOST_OPEN_CURRENT_QUESTION",0);
 assert.match(asked.message,/第 1\.2 题/);
 assert.doesNotMatch(asked.message,/第 1 步/);
 const replied=mentorQuestionFixture(labelledInstructions,"我可以持续分享摄影经验",0);
 assert.match(replied.message,/第 1\.2 题/);
 const later=mentorQuestionFixture(laterStepInstructions,"我可以持续分享摄影经验",2);
 assert.match(later.message,/第 3\.4 题/);
 assert.doesNotMatch(later.message,/第 3 步/);
});
it("stays neutral when the host context carries no question label",()=>{
 const asked=mentorQuestionFixture(instructions,"HOST_OPEN_CURRENT_QUESTION",0);
 assert.match(asked.message,/当前这一题/);
 assert.doesNotMatch(asked.message,/第 \d+ 步/);
 const replied=mentorQuestionFixture(instructions,"我可以持续分享摄影经验",0);
 assert.match(replied.message,/当前这一题/);
 assert.doesNotMatch(replied.message,/第 \d+ 步/);
});
it("ignores a malformed label instead of inventing a number",()=>{
 const malformed='Allowed field IDs for the current step: ["offer"].\nCurrent information question: {"id":"offer","title":"可持续内容与商业卖点","label":"第2步"}';
 const r=mentorQuestionFixture(malformed,"HOST_OPEN_CURRENT_QUESTION",0);
 assert.match(r.message,/当前这一题/);
 assert.doesNotMatch(r.message,/第2步题|第 \d+ 步/);
});
it("targets the active second question, not the first field",()=>{
 const r=mentorQuestionFixture(instructions,"我可以持续分享摄影经验",0);
 assert.deepEqual(Object.keys(r.informationPatch),["offer"]);assert.match(r.message,/可持续内容与商业卖点/);assert.equal(r.informationPatch.offer.status,"provisional");
 assert.equal(r.inputKind,"answer");assert.equal(r.informationPatch.offer.basis,"user_statement");
});
it("classifies uncertainty so the host, not the fixture, refuses the naive copy",()=>{
 for(const input of ["不知道","不知道呢","我还不确定","没想好","I don't know","idk"]){
  const r=mentorQuestionFixture(instructions,input,0);
  assert.equal(r.inputKind,"uncertainty");
  assert.equal(r.informationPatch.offer?.basis,"user_statement");
  assert.match(r.message,/一项经验/);
 }
});
it("classifies acknowledgements and help requests as non-answers",()=>{
 for(const input of ["好的","可以","OK"]){assert.equal(mentorQuestionFixture(instructions,input,0).inputKind,"acknowledgement");}
 assert.equal(mentorQuestionFixture(instructions,"你帮我取名",0).inputKind,"request");
});
it("opens the current question itself and proposes for an Agent deliverable",()=>{
 const asked=mentorQuestionFixture(instructions,"HOST_OPEN_CURRENT_QUESTION",0);
 assert.equal(asked.inputKind,"answer");assert.deepEqual(asked.informationPatch,{});
 // The Agent's own opening is distinguishable from a reply to the user.
 assert.match(asked.message,/【导师主动引导，仅验证流程】/);
 assert.doesNotMatch(asked.message,/【分步模拟，仅验证流程】/);
 const proposed=mentorQuestionFixture(proposalInstructions,"HOST_OPEN_CURRENT_QUESTION",2);
 assert.equal(proposed.informationPatch.position.basis,"agent_proposal");
 assert.equal(proposed.informationPatch.position.nature,"decision");
});
it("proposes instead of copying an acknowledgement on an Agent deliverable",()=>{
 const r=mentorQuestionFixture(proposalInstructions,"好的",2);
 assert.equal(r.inputKind,"acknowledgement");
 assert.equal(r.informationPatch.position.basis,"agent_proposal");
 assert.notEqual(r.informationPatch.position.value,"好的");
});
it("preserves explicitly requested cross-step revision as a separate proposal",()=>{
 const r=mentorQuestionFixture(instructions,"模拟：修改第一步目标",1);assert.equal(r.targetStepId,"step-0");assert.deepEqual(Object.keys(r.informationPatch),["goal"]);
 assert.equal(r.inputKind,"revision_request");
});
