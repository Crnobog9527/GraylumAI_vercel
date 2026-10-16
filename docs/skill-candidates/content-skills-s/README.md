# 首批创作 Skill 候选清单（CONTENT-CONVERSATION-DRIVEN 的 S，未发布）

此目录只有文件清单、SHA-256 和说明，不包含私有 Skill 原文。完整候选保存在本机私有目录（`~/.graylum/content-skills/<包名>/`），不进公开仓库，做法同 [定位 Skill 候选](../positioning-mentor-v13/README.md)。

## 范围

依据：[#621 方案](../../launch/CONTENT_CONVERSATION_DRIVEN_PLAN.md) 第 3.4 节、第 14 节 Q2（Owner 2026-10-04：首批四个平台 Skill 由实施窗口起草，Owner 看过样例再发布），
[开工前置设计](../../launch/implementation/CONTENT_CONVERSATION_DRIVEN_PRECONDITIONS.md) 第 6.1 节 S 行和第 8.1 节（2026-10-13：除定位外不做强引导，多个 Skill 可以一起用）。

| 包名 | 内容 | 状态 |
| --- | --- | --- |
| `short-video-script` | 口播稿（连同标题、封面字、发布文案和话题标签） | 样稿已写，等 Owner 看样例 |
| 分镜 | 基于定稿口播稿，声明 `contentSource: script` | 等口播稿样稿通过后再写 |
| 剪辑建议 | 基于匹配当前口播稿的分镜，声明 `contentSource: storyboard` | 同上 |
| 图文 / 文章 | 图文笔记和长文章 | 同上 |

## 写法约定

- **不带步骤**：没有 `workflow.yaml` 的步骤和提问字段，不开强引导（2026-10-13 定稿）；只按用户意图加载。
- **SKILL.md 自成一体**：管理员发布时每个文件的 `requires` 为空（`modulePublication.ts`），对话里只自动加载 `SKILL.md`，
  所以写作要求、平台差异和合规规则都写在 `SKILL.md` 里，不放进需要另外读取的参考文件。`EVALS.md` 只给验收用，不进对话。
- **内容来源**：分镜和剪辑建议需要的 `contentSource` 字段由 A2 扩展 `workflowManifest.ts` 后才能声明；在那之前这两个包只写 `SKILL.md`，
  `workflow.yaml` 随 A2 合并后补上并重新登记哈希。
- **规则来源**：v11 第 5.3 节的产品规则（分镜对应口播段落、画面、时长；剪辑说明开头、节奏、字幕、声音；给新手可执行方案；
  不做图片视频生成和真实剪辑）；定位 Skill 已有的平台红线和合规提醒（国内平台不站外引流、绝对化用语、商业合作标注等）；
  Owner 对提问方式的要求（问题配为什么问和具体例子清单、一次一个问题、起步只定一个目标）。
- **语言**：Skill 内核只有简体中文（SKILL-I18N-HOOK 决定）；跟用户用他的语言聊，稿子按目标观众的语言写。

## 发布

不在本 PR 发布。Owner 看过样例并确认后，由总控另行安排用现有管理员 Skill 包发布生成新版本；发布后从 staging 读回逐文件哈希，
和 `file-hashes.json` 核对。真实模型行为在 #621 第 11.3 节付费小评测和 staging 验收里跑，之前一律 NOT_RUN。
