import { randomToken } from './tokens.js';

/** In-memory magic-link tokens (single process). Links are logged in dev. */
const tokens = new Map<string, { email: string; expires: number }>();
const TTL_MS = 15 * 60_000;

export function issueMagicToken(email: string): string {
  for (const [t, v] of tokens) if (v.expires < Date.now()) tokens.delete(t);
  const token = randomToken(24);
  tokens.set(token, { email, expires: Date.now() + TTL_MS });
  return token;
}

export function consumeMagicToken(token: string): string | null {
  const v = tokens.get(token);
  if (!v) return null;
  tokens.delete(token);
  if (v.expires < Date.now()) return null;
  return v.email;
}
