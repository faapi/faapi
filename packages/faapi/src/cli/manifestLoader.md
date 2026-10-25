# manifestLoader

一句话概括：routes/tools/agents/tasks 四类产物清单的「读取 → 水合/求值 → 灌入注册表」装载层，从 createAppCore 拆出。

## 为什么需要

清单装载与 app 编排（server 创建/插件/生命周期）正交，且 dev 热替换（reloadTools/reloadAgents/reloadTasks）复用同一组函数——收口在一个模块后，新增清单类型（hydrate + 注册表灌入）只改一处。

## 使用场景

- `createAppBase` 启动时依次装载三类可选清单（tool/agent/task）
- `createDevApp` 的 reload* 热替换（`setLoadTimestamp` 由外层设置，绕 ESM 缓存）
- `getTaskDriverOptions` 读取 `config.task` 的驱动连接选项透传驱动工厂

## 行为约定

- routes 清单必需（缺失启动报错，校验留在 createAppCore）；tools/agents/tasks 可选——清单文件缺失返回空数组、注册表保持空，不报错
- import 走 `importWithCacheBust`（watch 模式时间戳绕缓存）
- 水合目标是 **app 实例注册表**（`registries.tool/agent/task.hydrate`），默认参数的全局实例仅编程式直调/测试用
- **agent 清单走求值链路而非直接水合**：`loadAndHydrateAgents` 读 `faapi-agents.js` 定位清单（name/filePath/inputTypeName 静态事实）后委托 [loadAndEvaluateAgents](../agents/loadAgents.md)——逐个动态 import handler 产物模块求值 `config` 导出 + 逐字段校验，产出 `AgentMetadata[]` 才灌入 agentRegistry。**清单 import 与 handler 模块 import 都经 `importWithCacheBust`**——dev 改 agent config 后 reload 能拿到新模块（时间戳已由外层 `setLoadTimestamp` 更新）

## 相关模块

- `createAppCore.ts` — 编排消费方
- `../agents/loadAgents.ts` — agent 声明求值管线（`loadAndHydrateAgents` 的实现核心）
- `./generateToolArtifacts.ts` / `./generateAgentArtifacts.ts` / `./generateTaskArtifacts.ts` — 清单文件名与各自的水合/求值入口
- `../injection/registries.ts` — AppRegistries 实例
