---
'@faapi/faapi': minor
'@faapi/agent': minor
---

单进程单 app（多 app 同进程不支持）+ 运行时资源读取统一为免传参 `readResource`：

- **单 app 强制**：`createAppBase` 检测到进程内已有存活 app 时显式抛错（提示先 `close()` 或用子进程隔离）——单例语义、全局日志、资源读取根绑定等进程级资源都以唯一 app 为前提。此前同进程多次创建为"覆盖单例"的未定义行为
- **`readResource(relativePath, encoding?)`**：参数为相对路径，只能读取 resources 目录内的文件（绝对路径 / `..` 穿越 / 符号链接逃逸显式抛错，resources 内合法软链不误伤）；读取根在 app 启动时绑定、隔离任务 worker 由 wrapper 从快照播种、testing 直调经 `createTestContext` 的 `resourcesDir` 选项绑定，调用方（HTTP/WS handler、任务、插件、lifecycle）统一用这一个函数
- **撤掉同批引入的 `ctx.readResource` sugar**（未随任何版本发布），保持单一读取形态
- **agent `systemPromptFile` 读取切换到免传参 `readResource`**，获得越界/符号链接逃逸防护；`AgentDeps.resourcesDir` 字段随之移除（唯一读者消失成死字段）——app 内与隔离 worker 场景读取根自动就位，无需手工注入

> 留痕说明：多 app 能力此前记录于注册表实例化章节，去掉属行为收敛，按语义为 breaking（major）；经维护者确认业务侧无同进程多 app 使用，按 minor 发版（同 agent 自定义 run 移除先例）。
