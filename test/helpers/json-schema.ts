/**
 * Tiny JSON Schema (2020-12 subset) validator for tests: enough of the
 * keywords used by dotmock-v2.schema.json to catch contract drift without
 * adding a dependency.
 */
type Schema = boolean | Record<string, any>;

export function validateSchema(root: Record<string, any>, value: unknown): string[] {
  const errors: string[] = [];
  const resolveRef = (ref: string): Schema => {
    if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
    return ref.slice(2).split("/").reduce<any>((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  };
  const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  const check = (schema: Schema, v: unknown, path: string): boolean => {
    const before = errors.length;
    if (schema === true) return true;
    if (schema === false) { errors.push(`${path}: not allowed`); return false; }
    if (schema.$ref) check(resolveRef(schema.$ref), v, path);
    if (schema.type) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      const actual = typeOf(v);
      if (!types.some((t: string) => t === actual || (t === "number" && actual === "integer"))) errors.push(`${path}: expected ${types.join("|")}, got ${actual}`);
    }
    if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
    if (schema.enum && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
    if (typeof v === "string") {
      if (schema.minLength !== undefined && v.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && v.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
      if (schema.pattern && !new RegExp(schema.pattern, "u").test(v)) errors.push(`${path}: does not match ${schema.pattern}`);
    }
    if (typeof v === "number") {
      if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${path}: < ${schema.minimum}`);
      if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${path}: > ${schema.maximum}`);
    }
    if (Array.isArray(v)) {
      if (schema.items !== undefined) v.forEach((item, i) => check(schema.items, item, `${path}/${i}`));
      if (schema.uniqueItems && new Set(v.map((item) => JSON.stringify(item))).size !== v.length) errors.push(`${path}: items not unique`);
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      for (const key of schema.required ?? []) if (!(key in obj)) errors.push(`${path}: missing required ${key}`);
      for (const [key, sub] of Object.entries(schema.properties ?? {})) if (key in obj) check(sub as Schema, obj[key], `${path}/${key}`);
      if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
        for (const key of Object.keys(obj)) {
          if (schema.properties && key in schema.properties) continue;
          check(schema.additionalProperties, obj[key], `${path}/${key}`);
        }
      }
    }
    for (const sub of schema.allOf ?? []) check(sub, v, path);
    const passes = (sub: Schema) => { const mark = errors.length; const ok = check(sub, v, path); errors.length = mark; return ok; };
    if (schema.anyOf && !schema.anyOf.some(passes)) errors.push(`${path}: matches none of anyOf`);
    if (schema.oneOf && schema.oneOf.filter(passes).length !== 1) errors.push(`${path}: must match exactly one of oneOf`);
    if (schema.if !== undefined) {
      if (passes(schema.if)) { if (schema.then !== undefined) check(schema.then, v, path); }
      else if (schema.else !== undefined) check(schema.else, v, path);
    }
    return errors.length === before;
  };
  check(root, value, "");
  return errors;
}
