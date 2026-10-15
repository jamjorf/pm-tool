import { describe, expect, it } from 'vitest';
import { extractKeys, extractKeysFromBranch, keyFromUrl } from '../keys.js';

describe('key extraction', () => {
  it('extracts keys from branch names case-insensitively', () => {
    expect(extractKeysFromBranch('rates-12-fix')).toEqual(['RATES-12']);
    expect(extractKeysFromBranch('refs/heads/feature/RATES-12-and-ops-3')).toEqual(['RATES-12', 'OPS-3']);
    expect(extractKeysFromBranch('alice/rates-12_rates-12')).toEqual(['RATES-12']);
    expect(extractKeysFromBranch('main')).toEqual([]);
    expect(extractKeysFromBranch('v-2')).toEqual([]); // single-letter prefix is not a project key
  });

  it('extracts uppercase keys from prose and de-duplicates', () => {
    expect(extractKeys('Fixes RATES-12 and relates to OPS-3, see RATES-12 again')).toEqual(['RATES-12', 'OPS-3']);
    expect(extractKeys('')).toEqual([]);
  });

  it('finds the key in a web app URL', () => {
    expect(keyFromUrl('http://app.test/items/RATES-12')).toBe('RATES-12');
    expect(keyFromUrl('http://app.test/p/RATES/i/rates-12?tab=activity')).toBe('RATES-12');
    expect(keyFromUrl('http://app.test/search?q=hello')).toBeNull();
  });
});
