---
'@faapi/faapi': patch
---

tool handler 第二参 ctx 校验类型补齐全部标注形态（此前仅内联交叉 `ctx: WriterToolCtx & AgentToolContext` 单一合法写法，其余形态构建期撞上 `AgentToolContext` 的 `import('...').TaskClient` 类型语法报错或静默不校验）：

- 命名别名解引用：别名 `= 唯一具名业务成员 & AgentToolContext` → 取业务名，与内联交叉同路径同 schema 名
- 别名默认名：别名 `= A & B & AgentToolContext`（多业务成员）/ `= { userId } & AgentToolContext`（内联业务）→ **默认名 = 别名名**，`extractCtxTypeInfo` 剥离解析：跳过框架侧成员，逐成员解析按交叉合并语义合并为单 schema（导出 `别名名Schema`）；非 object 成员、同名字段冲突显式抛错
- 内联标注默认名：纯内联字面量 / 内联交叉（无任何名字）→ **默认名 = `${函数名}Ctx`**，`extractCtxTypeInfo` 内联回退从源码第二参标注直接解析（TypeLiteral 整体解析、交叉剥离框架侧合并，内联字段不丢）；合成名与文件内已有类型声明同名时构建期显式抛错（防校验被同名声明劫持）
- 维持不生成 schema：裸标注 `AgentToolContext` / 仅框架侧交叉 / 关键词类型标注（`unknown` 等）；interface extends 框架契约类型仍不支持（交叉标注为唯一携带形态）
