// Minimal JSON Schema draft 2020-12 validator (subset) used only by the tests.
//
// It exists so the frozen schemas under schemas/ can be exercised with a real
// positive/negative evaluation without adding a runtime dependency. Supported
// keywords: $ref, type (single or union), required, additionalProperties,
// properties, patternProperties, items, prefixItems, minItems, maxItems,
// minimum, maximum, minLength, maxLength, pattern, enum, const, allOf, anyOf,
// oneOf, not, if/then/else, and the no-op annotations title/description/default/
// format/deprecated/$comment.
//
// Unknown keywords are ignored, exactly like a permissive validator would.

const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

export function matchesType(value, type) {
  if (!JSON_TYPES.has(type)) throw new Error(`unsupported type keyword "${type}"`);
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

function typeLabel(type) {
  return Array.isArray(type) ? `[${type.join(',')}]` : String(type);
}

function describe(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (typeof value === 'object') return `object(keys=${Object.keys(value).join(',') || '-'})`;
  if (typeof value === 'string') return `string(${value.length})`;
  return `${typeof value}(${String(value)})`;
}

function escapePointerToken(token) {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapePointerToken(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

/** Build a `#/$defs`- and `$id`-aware `$ref` resolver for one schema document. */
function makeResolver(rootDocument) {
  const byId = new Map();
  const byPointer = new Map();

  function walk(node, pointer, scopePointer) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((child, index) => walk(child, `${pointer}/${index}`, `${scopePointer}/${index}`));
      return;
    }
    const scope = typeof node.$id === 'string' ? '#' : scopePointer;
    if (typeof node.$id === 'string') byId.set(node.$id, { node, scope: '#' });
    const entry = { node, scope, pointer };
    byPointer.set(pointer, entry);
    if (!byPointer.has(scope)) byPointer.set(scope, entry);
    for (const [key, child] of Object.entries(node)) {
      walk(child, `${pointer}/${key}`, `${scope}/${key}`);
    }
  }
  walk(rootDocument, '#', '#');

  return function resolve(uri) {
    if (typeof uri !== 'string' || uri.length === 0) return undefined;
    const hashIndex = uri.indexOf('#');
    const documentPart = hashIndex === -1 ? uri : uri.slice(0, hashIndex);
    const fragment = hashIndex === -1 ? '' : uri.slice(hashIndex + 1);

    let baseScope = '#';
    if (documentPart !== '') {
      const target = byId.get(documentPart);
      if (!target) return undefined;
      baseScope = target.scope;
      if (fragment === '') return target;
    }
    if (fragment === '') return byPointer.get(baseScope);

    const normalizedFragment = fragment.startsWith('/')
      ? `/${fragment.slice(1).split('/').map(unescapePointerToken).join('/')}`
      : fragment;
    const inside = `${baseScope}${normalizedFragment}`;
    if (byPointer.has(inside)) return byPointer.get(inside);
    return byPointer.get(`#${normalizedFragment}`);
  };
}

/**
 * Validate `value` against `schema`.
 * @returns {{valid: boolean, errors: Array<{instancePath: string, keyword: string, message: string}>}}
 */
export function validate(schema, value, { rootDocument = schema } = {}) {
  const resolve = makeResolver(rootDocument);
  const errors = [];

  /** Returns the errors produced by `node` without mutating the shared list. */
  function collect(node, data, instancePath, depth) {
    const local = [];
    if (depth > 60) return local;
    if (node === undefined || node === null || typeof node !== 'object') return local;

    const fail = (keyword, message) => {
      local.push({ instancePath: instancePath || '/', keyword, message });
    };

    if (typeof node.boolean === 'boolean') {
      if (node === false) fail('boolean', 'schema is false');
      return local;
    }

    if (typeof node.$ref === 'string') {
      const target = resolve(node.$ref);
      if (!target) {
        fail('$ref', `unresolvable $ref ${node.$ref}`);
        return local;
      }
      return collect(target.node, data, instancePath, depth + 1);
    }

    if (Array.isArray(node.type)) {
      if (!node.type.some((t) => matchesType(data, t))) {
        fail('type', `expected ${typeLabel(node.type)}, got ${describe(data)}`);
        return local;
      }
    } else if (node.type !== undefined) {
      if (!matchesType(data, node.type)) {
        fail('type', `expected ${node.type}, got ${describe(data)}`);
        return local;
      }
    }

    if (node.const !== undefined && !deepEqual(data, node.const)) {
      fail('const', `must equal ${JSON.stringify(node.const)}, got ${describe(data)}`);
    }
    if (Array.isArray(node.enum) && !node.enum.some((candidate) => deepEqual(data, candidate))) {
      fail('enum', `must be one of ${node.enum.map((v) => JSON.stringify(v)).join('|')}, got ${describe(data)}`);
    }

    if (typeof data === 'number') {
      if (typeof node.minimum === 'number' && data < node.minimum) fail('minimum', `must be >= ${node.minimum}, got ${data}`);
      if (typeof node.maximum === 'number' && data > node.maximum) fail('maximum', `must be <= ${node.maximum}, got ${data}`);
      if (typeof node.exclusiveMinimum === 'number' && data <= node.exclusiveMinimum) fail('exclusiveMinimum', `must be > ${node.exclusiveMinimum}, got ${data}`);
      if (typeof node.exclusiveMaximum === 'number' && data >= node.exclusiveMaximum) fail('exclusiveMaximum', `must be < ${node.exclusiveMaximum}, got ${data}`);
    }

    if (typeof data === 'string') {
      if (typeof node.minLength === 'number' && data.length < node.minLength) fail('minLength', `must have length >= ${node.minLength}`);
      if (typeof node.maxLength === 'number' && data.length > node.maxLength) fail('maxLength', `must have length <= ${node.maxLength}`);
      if (typeof node.pattern === 'string' && !new RegExp(node.pattern).test(data)) {
        fail('pattern', `must match ${node.pattern}, got ${JSON.stringify(data)}`);
      }
    }

    if (Array.isArray(data)) {
      if (typeof node.minItems === 'number' && data.length < node.minItems) fail('minItems', `must have >= ${node.minItems} item(s), got ${data.length}`);
      if (typeof node.maxItems === 'number' && data.length > node.maxItems) fail('maxItems', `must have <= ${node.maxItems} item(s), got ${data.length}`);
      if (Array.isArray(node.prefixItems)) {
        node.prefixItems.forEach((sub, index) => {
          if (index < data.length) local.push(...collect(sub, data[index], `${instancePath}/${index}`, depth + 1));
        });
      }
      if (node.items !== undefined) {
        const start = Array.isArray(node.prefixItems) ? node.prefixItems.length : 0;
        for (let index = start; index < data.length; index += 1) {
          local.push(...collect(node.items, data[index], `${instancePath}/${index}`, depth + 1));
        }
      }
    }

    if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
      if (Array.isArray(node.required)) {
        for (const key of node.required) {
          if (!Object.prototype.hasOwnProperty.call(data, key)) {
            fail('required', `missing required property "${key}"`);
          }
        }
      }
      const declared = node.properties ?? {};
      for (const [key, sub] of Object.entries(declared)) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
          local.push(...collect(sub, data[key], `${instancePath}/${escapePointerToken(key)}`, depth + 1));
        }
      }
      for (const [pattern, sub] of Object.entries(node.patternProperties ?? {})) {
        const re = new RegExp(pattern);
        for (const key of Object.keys(data)) {
          if (re.test(key)) local.push(...collect(sub, data[key], `${instancePath}/${escapePointerToken(key)}`, depth + 1));
        }
      }
      if (node.additionalProperties !== undefined && node.additionalProperties !== true) {
        for (const key of Object.keys(data)) {
          if (Object.prototype.hasOwnProperty.call(declared, key)) continue;
          if (Object.keys(node.patternProperties ?? {}).some((p) => new RegExp(p).test(key))) continue;
          if (node.additionalProperties === false) {
            fail('additionalProperties', `unknown property "${key}" is not part of the frozen field table`);
          } else {
            local.push(...collect(node.additionalProperties, data[key], `${instancePath}/${escapePointerToken(key)}`, depth + 1));
          }
        }
      }
    }

    for (const sub of node.allOf ?? []) local.push(...collect(sub, data, instancePath, depth + 1));

    const passes = (sub) => collect(sub, data, instancePath, depth + 1).length === 0;

    if (Array.isArray(node.anyOf) && !node.anyOf.some((sub) => passes(sub))) {
      fail('anyOf', 'must match at least one subschema');
    }
    if (Array.isArray(node.oneOf)) {
      const matched = node.oneOf.filter((sub) => passes(sub)).length;
      if (matched !== 1) fail('oneOf', `must match exactly one subschema, matched ${matched}`);
    }
    if (node.not !== undefined && passes(node.not)) {
      fail('not', 'must not match the "not" subschema');
    }

    if (node.if !== undefined) {
      const branch = passes(node.if) ? node.then : node.else;
      if (branch !== undefined) local.push(...collect(branch, data, instancePath, depth + 1));
    }

    return local;
  }

  errors.push(...collect(schema, value, '', 0));
  return { valid: errors.length === 0, errors };
}
