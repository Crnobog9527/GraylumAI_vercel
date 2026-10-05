/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Public projection of the pinned six-step, nine-field workflow; no private Skill prose.
const titles=['需求确认','竞品研究','账号定位','内容策略','运营建议','商业规划'];
const fields=[
 [['product','产品与服务','user_fact'],['platforms','准备经营的平台','user_fact'],['time','每周可用时间','user_fact']],
 [['reference','参考研究结论','agent_proposal']],
 [['audience','优先服务的用户','agent_proposal'],['difference','价值与依据','user_fact']],
 [['roles','内容表达与平台安排','agent_proposal']],
 [['cadence','可持续的制作安排','agent_proposal']],
 [['offer','内容如何支持业务','agent_proposal']],
] as const;
export const captureWorkflowSteps=titles.map((title,index)=>({id:`step-${index+1}`,title,resources:['SKILL.md'],
 information:fields[index]!.map(([id,title,elicitation])=>({id,title,required:true,profileKey:id,elicitation})),
}));
