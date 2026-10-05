/**
 * PHI scrubber for logs, traces and error reports (§20.2 "PHI-safe observability"). Anything
 * leaving the process for observability passes through scrub(). It keeps identifiers (UUIDs),
 * status codes and timings, and redacts every key that can carry patient content plus any
 * value that looks like a date of birth, phone, email or SSN.
 */
const SENSITIVE_KEYS = new Set(
  [
    'name', 'legalgivenname', 'legalfamilyname', 'preferredname', 'formernames', 'firstname', 'lastname',
    'dateofbirth', 'dob', 'birthdate', 'email', 'phone', 'address', 'addressline', 'value', 'ssn',
    'note', 'notes', 'body', 'chiefcomplaint', 'reason', 'sig', 'indication', 'drugdisplay', 'substance',
    'reaction', 'medication', 'condition', 'password', 'totp', 'token', 'authorization', 'cookie',
    'database64', 'details', 'changes', 'memberid', 'identifier', 'dea',
  ].map((k) => k.toLowerCase()),
);

const PATTERNS: [RegExp, string][] = [
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[ssn]'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]'],
  [/\b(19|20)\d{2}-\d{2}-\d{2}\b/g, '[date]'],
  [/\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[phone]'],
];

export function scrubString(s: string): string {
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase().replace(/[_-]/g, '')) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}
