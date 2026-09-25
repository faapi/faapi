---
'@faapi/faapi': patch
---

框架修复与性能批次：

- **cron 多实例防重修复**：幂等键从 croner `currentRun()`（实际触发时刻，毫秒精度——多实例各自 setTimeout 的毫秒级抖动导致键几乎必然不同，"只入队一份"承诺实际失效）改为 `nextRun()` 捕获的**计划槽位**（秒级对齐、毫秒恒为 0，与实际触发时刻无关）。时钟同步下多实例同窗同键，防重语义恢复；跳过的槽位不补投（与 croner"错过即错过"语义一致）
- **dev watcher 删除文件修复**：`unlink` 事件现在把文件从待编译集合剔除（rebuildScheduler 新增 `removeFiles`），重建批次编译前再过滤已删除文件——此前 git 切分支等 change+unlink 批量场景下，幽灵文件随失败回灌永久卡住整批编译（每轮撞同一个 "Could not read from file"），同批新文件永远编译不到，直到重启
- **JSON 序列化快路径**：整棵值树均为 JSON 原生类型（绝大多数响应形态）时零分配直通原生 `JSON.stringify`，不再对每个响应付出一次全量深拷贝（此前 plain object/array 无条件递归重建，大响应 GC 压力翻倍）；Date/BigInt/Map/Set/NaN/RegExp/toJSON/循环引用等转换语义与错误行为完全不变
- **dev 保存延迟优化**：新增 `DevApp.reloadAll()` 批量热替换入口，watcher 一轮重建的 Program 缓存失效从 4 次收敛为 1 次——此前 `reloadRoutes/reloadTools/reloadAgents/reloadTasks` 各自开头清 Program 缓存，单次保存触发 4 次全项目 ts.Program 重建（保存延迟随项目体积而非变更大小增长）；程序化直调单个 reload* 的语义不变（各自失效）
