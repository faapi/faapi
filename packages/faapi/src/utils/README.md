# 通用工具函数

提供请求处理过程中复用的工具函数。

## 模块

| 模块 | 说明 |
| --- | --- |
| [normalizePath.ts](./normalizePath.ts) | 路径标准化：反斜杠→正斜杠、去重复斜杠、去尾部斜杠、确保 `/` 开头 |
| [queryToObject.ts](./queryToObject.ts) | URLSearchParams → plain object |
| [parseJsonBody.ts](./parseJsonBody.ts) | JSON body 解析，返回 `{ success, data }` 或 `{ success, error }` |
| [parseMultipart.ts](./parseMultipart.ts) | multipart/form-data 解析，使用 Web 标准 `Request.formData()` API |
| [isPlainObject.ts](./isPlainObject.ts) | 判断是否为普通对象（排除数组、null、非 Object 原型） |
| [getClientIp.ts](./getClientIp.ts) | 客户端 IP 提取（X-Forwarded-For 优先,IPv6 规整） |
| [importWithCacheBust.ts](./importWithCacheBust.ts) | ESM cache bust 加载（dev 热替换用） |
| [readTsconfig.ts](./readTsconfig.ts) | 读取 tsconfig paths 别名配置 |
| [resolveAlias.ts](./resolveAlias.ts) | 别名 specifier → 候选绝对路径解析（编译期重写用） |

## parseMultipart 返回结构

```ts
{
  fields: Record<string, string>,  // 普通表单字段
  files: UploadedFile[]            // 上传文件列表
}
```

UploadedFile 包含：name、filename、type、size、arrayBuffer()。
