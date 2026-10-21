---
'@faapi/faapi': minor
---

下线 skillRegistry（DB skill）功能：移除 `hydrateSkillRegistry` / `upsertSkill` / `removeSkill` / `getSkill` / `listSkills` 全局函数、`SkillRegistry` 类型、`ctx.registries.skill` 与任务侧 `taskCtx.registries.skill` 只读视图、隔离任务 `TaskRegistriesSnapshot.skills` 快照字段。skillRegistry 在框架内已无任何消费方（agent 查询不 fallback、`agents` 注入不含它、Agent 类不消费），且业务实践（用户/租户维度的技能）证明「全局共享、名键唯一」的注册表模型不成立。需要运行时动态 agent 元数据的业务方请自行实现「实时查库 + LLM 可见花名册 + tool 按需读取」链路，不经框架注册表。
