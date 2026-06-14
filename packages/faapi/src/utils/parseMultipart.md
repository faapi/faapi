# parseMultipart

一句话概括：解析 multipart/form-data 请求，返回字段和文件

## 为什么需要

文件上传和表单提交需要解析 multipart 格式

## 使用场景

POST/PUT/PATCH 请求 content-type 为 multipart/form-data 时自动调用

## 相关模块

- `resolveInput.ts` - 请求体解析入口
- `injectParams.ts` - 参数注入
