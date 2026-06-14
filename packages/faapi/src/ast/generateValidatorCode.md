# generateValidatorCode

一句话概括：将 RuntimeType 编译为校验函数 JS 源码。

## 为什么需要

运行时校验有两种实现方式：
1. 记录类型结构（RuntimeType），运行时解释校验 —— 当前旧方案
2. build 时直接生成校验函数源码，运行时直接调用 —— 本模块

方案 2 的优势：
- 运行时无需解释类型结构，性能更好
- 天然支持循环引用（JS 函数递归）
- prd 模式生成 `dist/faapi-schema.js`，比 JSON 更直接

## 使用场景

- dev 模式：`generateValidatorSource` 生成源码 → `new Function` 动态创建校验函数
- prd 模式：`generateSchemaModule` 生成完整 JS 模块 → 写入 `dist/faapi-schema.js`

## API

### `generateValidatorSource(typeInfo: HandlerTypeInfo): string`

生成单个类型的校验函数源码（函数体，不含外层包装）。

### `generateSchemaModule(entries: SchemaModuleEntry[]): string`

生成完整的 JS 模块源码，包含：
- 所有命名类型的 `validate_X` 函数声明
- 导出 `validators` 对象：`{ 'filePath#schemaName': (input) => ValidationResult }`

## 生成的代码结构

对于：
```ts
interface TreeNode { value: number; children: TreeNode[]; parent?: TreeNode }
interface GETQuery { id: number; tree: TreeNode }
```

生成：
```js
function validate_TreeNode(value, path, issues) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: '期望对象' });
    return;
  }
  if (!('value' in value)) issues.push({ path: path + '.value', message: '缺少必填字段 "value"' });
  else if (typeof value.value !== 'number') issues.push({ path: path + '.value', message: '期望 number，实际 ' + typeof value.value });
  if (!('children' in value)) issues.push({ path: path + '.children', message: '缺少必填字段 "children"' });
  else if (!Array.isArray(value.children)) issues.push({ path: path + '.children', message: '期望数组' });
  else for (let i = 0; i < value.children.length; i++) validate_TreeNode(value.children[i], path + '.children[' + i + ']', issues);
  if ('parent' in value && value.parent !== undefined) validate_TreeNode(value.parent, path + '.parent', issues);
}

const validators = {
  'api/tree/handler.ts#GETQuery': (input) => {
    const issues = [];
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return { valid: false, issues: [{ path: '', message: '输入必须是对象' }], data: {} };
    }
    if (!('id' in input)) issues.push({ path: 'id', message: '缺少必填字段 "id"' });
    else if (typeof input.id !== 'number') issues.push({ path: 'id', message: '期望 number' });
    if (!('tree' in input)) issues.push({ path: 'tree', message: '缺少必填字段 "tree"' });
    else validate_TreeNode(input.tree, 'tree', issues);
    return { valid: issues.length === 0, issues, data: input };
  }
};

export { validators };
```

## 循环引用处理

- 每个命名类型生成独立的 `validate_X` 函数
- 遇到自引用（如 `children: TreeNode[]`）直接调用 `validate_TreeNode`
- JS 函数声明会提升，同模块内互相引用无需特殊处理
- 跨文件引用：所有 `validate_X` 函数在同一模块内，不存在跨文件问题

## 相关模块

- `resolveTypeNode.ts` - 提供 RuntimeType
- `extractHandlerTypes.ts` - 提供 HandlerTypeInfo
- `schemaRegistry.ts` - 注册生成的校验函数
- `generateSchema.ts` - 调用本模块生成 JS 模块
