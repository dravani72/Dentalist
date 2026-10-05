/**
 * Canonical JSON for attestation (MASTER_SPEC §13 step 2): object keys sorted, no insignificant
 * whitespace, undefined dropped, numbers in shortest round-trip form. The same payload always
 * produces the same bytes, so a SHA-256 over it is a stable tamper-evidence digest.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(v: unknown): string {
  if (v === null) return 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error('Non-finite number in canonical payload');
      return JSON.stringify(v);
    case 'bigint':
      return JSON.stringify(v.toString());
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : serialize(x))).join(',') + ']';
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return '{' + keys.map((k) => JSON.stringify(k) + ':' + serialize(obj[k])).join(',') + '}';
    }
    default:
      throw new Error(`Cannot canonicalize ${typeof v}`);
  }
}
