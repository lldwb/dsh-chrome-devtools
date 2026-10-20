// Lead 的独立 schema 审计器（双保险）：镜像 dsh 的严格 JSON Schema 子集校验 + 返回值校验。
//
// 为什么独立写一份：T2 自己在 test/tool-schema.test.mjs 里也写了一个校验器，如果那个校验器
// 本身写错（放宽了规则），测试会假绿。这里按 dsh 的规则从零实现一遍，用两套独立实现互相钉住。
//
// dsh 的规则（见 dsh-plugin-development skill §12，实测结论）：
//   1. 支持的键：type / oneOf / properties / required / additionalProperties / items / enum / const
//      + 注释键 description / title / default / examples。其它键一律不收。
//   2. required 必须是字符串数组，且每个名字都在 properties 里。
//   3. 属性上的 required: true 是非法写法（会让整个插件不激活）。
//   4. type 必须是单个字符串（不允许 type 数组）。
//   5. oneOf 旁边不能有 properties/required/additionalProperties/items/enum/const。
//   6. execute 的返回值必须满足自己声明的 output.schema（additionalProperties:false 下多字段即失败）。
//
// 用法：
//   node test/lead-schema-audit.mjs            # 只审计工具定义
import { resolveOptions } from '../lib/config.mjs';
import { BrowserManager } from '../lib/connection.mjs';
import { buildTools } from '../lib/tools.mjs';

const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples']);
const SCHEMA_KEYS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  ...ANNOTATION_KEYS,
]);
const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
/** oneOf 旁边不允许出现的键。 */
const ONE_OF_FORBIDDEN = new Set(['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);

/**
 * 校验一个 schema 节点是否落在 dsh 支持的子集里。
 *
 * @param {unknown} node 待校验的 schema。
 * @param {string} path 诊断用路径。
 * @param {string[]} errors 收集器。
 * @returns {void}
 */
function checkSchemaNode(node, path, errors) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${path}: schema 节点必须是对象，实际是 ${Array.isArray(node) ? 'array' : typeof node}`);
    return;
  }
  for (const key of Object.keys(node)) {
    if (!SCHEMA_KEYS.has(key)) errors.push(`${path}: 不支持的 schema 键 "${key}"`);
  }

  const type = node.type;
  if (type !== undefined) {
    if (typeof type !== 'string') errors.push(`${path}.type: 必须是单个字符串（不支持 type 数组）`);
    else if (!JSON_TYPES.has(type)) errors.push(`${path}.type: 未知类型 "${type}"`);
  }

  if (node.oneOf !== undefined) {
    for (const key of Object.keys(node)) {
      if (ONE_OF_FORBIDDEN.has(key)) errors.push(`${path}: oneOf 旁不能有 "${key}"`);
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) {
      errors.push(`${path}.oneOf: 必须是非空数组`);
    } else {
      node.oneOf.forEach((sub, index) => checkSchemaNode(sub, `${path}.oneOf[${index}]`, errors));
    }
  }

  if (node.properties !== undefined) {
    if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      errors.push(`${path}.properties: 必须是对象`);
    } else {
      for (const [name, sub] of Object.entries(node.properties)) {
        checkSchemaNode(sub, `${path}.properties.${name}`, errors);
        // 属性上写 `required: true`（布尔）是最常见的致命错。
        // 但属性本身是 object schema 时，`required: ['field']` 数组是合法的（嵌套对象）。
        if (sub !== null && typeof sub === 'object' && Object.hasOwn(sub, 'required')) {
          if (typeof sub.required === 'boolean') {
            errors.push(`${path}.properties.${name}: 不能在属性上写 required: true（应放进父级 required 数组）`);
          } else if (!Array.isArray(sub.required)) {
            errors.push(`${path}.properties.${name}: required 必须是字符串数组`);
          } else if (sub.properties === undefined) {
            errors.push(`${path}.properties.${name}: 有 required 数组却没有 properties`);
          }
        }
      }
    }
  }

  if (node.required !== undefined) {
    if (!Array.isArray(node.required)) {
      errors.push(`${path}.required: 必须是字符串数组`);
    } else {
      const props = node.properties;
      for (const name of node.required) {
        if (typeof name !== 'string') errors.push(`${path}.required: 元素必须是字符串，实际 ${typeof name}`);
        else if (props === null || typeof props !== 'object' || !Object.hasOwn(props, name)) {
          errors.push(`${path}.required: 名字 "${name}" 不在 properties 里`);
        }
      }
    }
  }

  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean' && typeof node.additionalProperties !== 'object') {
    errors.push(`${path}.additionalProperties: 必须是布尔值或 schema 对象`);
  } else if (node.additionalProperties !== null && typeof node.additionalProperties === 'object') {
    checkSchemaNode(node.additionalProperties, `${path}.additionalProperties`, errors);
  }

  if (node.items !== undefined) checkSchemaNode(node.items, `${path}.items`, errors);

  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) errors.push(`${path}.enum: 必须是非空数组`);
  }
}

/**
 * 按 schema 校验一个值（只覆盖本插件用到的子集，够用即可）。
 *
 * @param {unknown} value 待校验值。
 * @param {object} schema schema 节点。
 * @param {string} path 诊断路径。
 * @param {string[]} errors 收集器。
 * @returns {void}
 */
function checkValue(value, schema, path, errors) {
  if (schema === null || typeof schema !== 'object') return;
  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.some((sub) => {
      const scratch = [];
      checkValue(value, sub, path, scratch);
      return scratch.length === 0;
    });
    if (!matched) errors.push(`${path}: 不匹配 oneOf 的任何分支（实际 ${JSON.stringify(value)?.slice(0, 120)}）`);
    return;
  }
  const type = schema.type;
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${path}: 期望 object，实际 ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
      return;
    }
    const props = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) errors.push(`${path}: 缺 required 字段 "${name}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(props, key)) errors.push(`${path}: 多出未声明字段 "${key}"（additionalProperties:false）`);
      }
    }
    for (const [name, sub] of Object.entries(props)) {
      if (Object.hasOwn(value, name) && value[name] !== undefined) checkValue(value[name], sub, `${path}.${name}`, errors);
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: 期望 array，实际 ${typeof value}`);
      return;
    }
    const items = schema.items;
    if (items !== undefined) value.forEach((entry, index) => checkValue(entry, items, `${path}[${index}]`, errors));
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: 期望 string，实际 ${typeof value}`);
    else if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: "${value}" 不在 enum 里`);
    return;
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path}: 期望 number，实际 ${typeof value}`);
    return;
  }
  if (type === 'integer') {
    if (!Number.isInteger(value)) errors.push(`${path}: 期望 integer，实际 ${value}`);
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path}: 期望 boolean，实际 ${typeof value}`);
    return;
  }
  if (type !== undefined && Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: 值不在 enum 里`);
  }
}

/**
 * 跑完整审计。
 *
 * @returns {{ ok: boolean, errors: string[], toolCount: number, names: string[] }}
 */
export function auditToolDefinitions() {
  const errors = [];
  const config = resolveOptions({
    scheme: 'launch',
    headless: true,
    isolated: true,
    toolset: 'full',
  });
  const manager = new BrowserManager(() => config);
  const definitions = buildTools({ manager, getConfig: () => config, logger: undefined });

  const names = new Set();
  for (const definition of definitions) {
    const label = definition?.name ?? '<unnamed>';
    if (names.has(label)) errors.push(`工具名重复: ${label}`);
    names.add(label);

    if (typeof definition.name !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(definition.name)) {
      errors.push(`${label}: 工具名必须是 lower snake_case ASCII`);
    }
    if (typeof definition.description !== 'string' || definition.description.length < 20) {
      errors.push(`${label}: description 缺失或过短`);
    }
    if (definition.parameters === undefined) errors.push(`${label}: 缺 parameters`);
    else checkSchemaNode(definition.parameters, `${label}.parameters`, errors);

    const output = definition.output;
    if (output === undefined || output.schema === undefined) errors.push(`${label}: 缺 output.schema`);
    else {
      checkSchemaNode(output.schema, `${label}.output.schema`, errors);
      if (typeof output.render !== 'function') errors.push(`${label}: 缺 output.render`);
      // 每个工具都必须有 summary（render 依赖它）。
      const props = output.schema?.properties;
      if (props === null || typeof props !== 'object' || !Object.hasOwn(props, 'summary')) {
        errors.push(`${label}: output.schema 里必须有 summary 字段`);
      } else if (!(output.schema.required ?? []).includes('summary')) {
        errors.push(`${label}: summary 必须在 required 里`);
      }
    }
    if (definition.presentCall !== undefined && typeof definition.presentCall !== 'function') {
      errors.push(`${label}: presentCall 必须是函数`);
    }
    if (typeof definition.execute !== 'function') errors.push(`${label}: 缺 execute`);
  }

  return { ok: errors.length === 0, errors, toolCount: definitions.length, names: [...names] };
}

const isMain = import.meta.url === `file:///${process.argv[1]?.replace(/\\/gu, '/')}`;
if (isMain) {
  const result = auditToolDefinitions();
  console.log(`工具数: ${result.toolCount}`);
  console.log(`工具名: ${result.names.join(', ')}`);
  if (result.ok) {
    console.log('✅ schema 审计通过（parameters + output.schema 都落在 dsh 支持的子集里）');
  } else {
    console.error(`❌ schema 审计失败（${result.errors.length} 个问题）：`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
  }
}
