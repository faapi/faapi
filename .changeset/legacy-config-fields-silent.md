---
'@faapi/faapi': minor
---

agent handler 的 config 声明支持历史字段静默忽略——`config.model` 不再报错：

- 新增 `LEGACY_CONFIG_FIELDS`（当前含 `model`）：声明中的历史已移除字段豁免「未知 config 字段」白名单校验、静默忽略——沿用「历史残留不做检测报错」规范（7.14.0 移除各残留检测护栏的同一口径），升级用户 config 里残留 `model: 'gpt-4o'` 不再导致 agent 启动失败。
- 「未知 config 字段」白名单对全新未知字段仍然报错（拼写错误防护不变，如 `systemPromt`）。

> 版本策略留痕：7.14.0 CHANGELOG 曾误记「运行时本无检测，声明被忽略」——实际 7.14.0 时 `config.model` 仍会撞白名单报错；本变更起才真正静默。勘误与沿革见根目录 `HISTORY.md` 1.1 节。
