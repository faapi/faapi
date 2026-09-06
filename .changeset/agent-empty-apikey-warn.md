---
"@faapi/agent": patch
---

@faapi/agent 启动时对空 apiKey 的 provider 打 warn

plugin setup 时校验 `config.agent.llms.<key>.apiKey`：空/缺失/纯空白字符时打印 warn（含 provider 名与修复提示），把「key 未配置」从首次 LLM 调用的上游 401 提前到启动日志。照常注册不跳过——部分网关/本地模型场景无需 key，跳过会破坏合法配置。
