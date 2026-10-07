/**
 * Thin client for the Teeth API. The session token lives in memory and sessionStorage only
 * (cleared when the tab closes); production moves it to an httpOnly cookie behind the gateway.
 * No patient data is ever put in a URL path or query beyond opaque ids.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

interface Client {
  api: { get<T>(path: string): Promise<T>; post<T>(path: string, body?: unknown): Promise<T> };
  getToken(): string | null;
  setToken(t: string | null): void;
  onTokenChange(fn: () => void): () => void;
}

/**
 * One client per kind of session: the workforce app and the patient portal keep separate
 * tokens (separate storage keys), so signing in to one never signs in to the other.
 */
export function createClient(tokenKey: string, prefix: string, publicPaths: readonly string[]): Client {
  const read = () => {
    try {
      return sessionStorage.getItem(tokenKey);
    } catch {
      return null;
    }
  };
  let token: string | null = read();
  const listeners = new Set<() => void>();
  const setToken = (t: string | null) => {
    token = t;
    try {
      if (t) sessionStorage.setItem(tokenKey, t);
      else sessionStorage.removeItem(tokenKey);
    } catch {
      /* storage unavailable: stay in memory */
    }
    listeners.forEach((l) => l());
  };
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`/api${prefix}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new ApiError(res.status, data?.error ?? 'error', data?.message ?? res.statusText, data?.details);
      if (res.status === 401 && err.code !== 'step_up_required' && !publicPaths.includes(path)) setToken(null);
      throw err;
    }
    return data as T;
  }
  return {
    api: {
      get: <T>(path: string) => request<T>('GET', path),
      post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
    },
    getToken: () => token,
    setToken,
    onTokenChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const staff = createClient('teeth.session', '', ['/auth/login']);
export const api = staff.api;
export const getToken = staff.getToken;
export const setToken = staff.setToken;
export const onTokenChange = staff.onTokenChange;

/** Patient portal session (separate identity, separate token). */
export const portal = createClient('teeth.portal', '/portal', ['/auth/start', '/auth/verify', '/auth/accept-invitation']);

/** Human-readable error text, including field-level validation issues. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const issues = (e.details as { issues?: { path: string; message: string }[] } | undefined)?.issues;
    const missing = (e.details as { missing?: string[] } | undefined)?.missing;
    if (issues?.length) return `${e.message}: ${issues.map((i) => (i.path ? `${i.path} ${i.message}` : i.message)).join('; ')}`;
    if (missing?.length) return `${e.message} (${missing.join(', ')})`;
    const canals = (e.details as { canals?: string[] } | undefined)?.canals;
    if (canals?.length) return `${e.message}: ${canals.join('; ')}`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
