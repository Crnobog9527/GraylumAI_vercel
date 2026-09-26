# Skill 定位步骤与问题

定位界面读取已发布 Skill 的工作流，不从 `SKILL.md` 的自由文字猜测步骤或问题。需要让重新上传同步改变界面时，在同一个 Skill 文件夹根目录放置 `workflow.yaml`，与 `SKILL.md` 一起上传、检查并发布。示例：

```yaml
kind: social
steps:
  - title: 需求确认
    resources: [SKILL.md]
    information:
      - id: product
        title: 产品与服务
        required: true
        profileKey: product
        elicitation: user_fact
  - title: 竞品研究
    resources: [SKILL.md]
    information:
      - id: reference
        title: 参考研究结论
        required: true
        profileKey: reference
        elicitation: agent_proposal
```

`steps` 的排列就是前端顺序；`title` 是步骤或问题的显示名称。`id` 是问题在该版本中的稳定标识，重命名显示文字时应保留；改变问题含义时使用新标识。`resources` 只能引用同包中真实存在的文件。每次上传时后台展示文件声明的步骤和问题，并在发布前核对它们与上传内容一致。发布成功后新开的定位使用新版本；已有定位仍按启动时绑定的版本继续。没有 `workflow.yaml` 的旧包仍可沿用旧配置，但只更新 `SKILL.md` 不会改变步骤或问题。
