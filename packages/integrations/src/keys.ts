// ============================================================================
// Item key extraction. `@pm/core` owns `extractItemKeys` (free text, uppercase
// keys like RATES-12). This module wraps it so that:
//   * a not-yet-built core stub does not crash an inbound webhook (we fall
//     back to the same regex locally), and
//   * branch names / URLs (lowercase, e.g. `rates-12-fix`) can be matched
//     case-insensitively, which core deliberately does not do for prose.
// ============================================================================
import { extractItemKeys as coreExtractItemKeys } from '@pm/core';

export const ITEM_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d+)\b/g;
export const ITEM_KEY_EXACT_RE = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
export const PROJECT_KEY_EXACT_RE = /^[A-Z][A-Z0-9]{1,9}$/;

function dedupe(keys: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (!seen.has(k)) { seen.add(k); out.push(k); }
  }
  return out;
}

/** Local fallback with the same contract as core's extractItemKeys (uppercase keys, de-duplicated, in order of appearance). */
export function extractKeysLocal(text: string): string[] {
  if (!text) return [];
  return dedupe(Array.from(text.matchAll(ITEM_KEY_RE), (m) => `${m[1]}-${m[2]}`));
}

/** Extract item keys from prose (Slack messages, PR titles/bodies, commit messages). Delegates to @pm/core. */
export function extractKeys(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const keys = coreExtractItemKeys(text);
    if (Array.isArray(keys)) return dedupe(keys.map((k) => k.toUpperCase()));
  } catch {
    // core stub not built yet (throws "not implemented") -> local regex
  }
  return extractKeysLocal(text);
}

/**
 * Extract item keys from identifiers that are conventionally lowercase:
 * git branch names (`rates-12-fix`, `feature/RATES-12`, `alice/rates-12-and-ops-3`), URLs, email tags.
 * Matches are case-insensitive and normalised to uppercase.
 */
export function extractKeysFromBranch(ref: string | null | undefined): string[] {
  if (!ref) return [];
  const name = ref.replace(/^refs\/(heads|tags)\//, '');
  // Split on separators that cannot be part of a key, then scan each segment.
  const re = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d+)(?![A-Za-z0-9])/g;
  const keys: string[] = [];
  for (const m of name.matchAll(re)) keys.push(`${m[1]!.toUpperCase()}-${m[2]}`);
  return dedupe(keys);
}

/** First item key found in a URL path/query (used for Slack link unfurls), or null. */
export function keyFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const haystack = decodeURIComponent(u.pathname + ' ' + u.search + ' ' + u.hash);
    return extractKeysFromBranch(haystack.replace(/[/?#=&]/g, ' '))[0] ?? null;
  } catch {
    return extractKeysFromBranch(url)[0] ?? null;
  }
}

export function isItemKey(s: string): boolean { return ITEM_KEY_EXACT_RE.test(s.toUpperCase()); }
export function isProjectKey(s: string): boolean { return PROJECT_KEY_EXACT_RE.test(s.toUpperCase()); }
