import { describe, expect, it } from 'vitest';
import { signSlackRequest, verifySlackSignature } from '../slack/verify.js';
import { signGithubRequest, verifyGithubSignature } from '../github/verify.js';

describe('verifySlackSignature', () => {
  const secret = '8f742231b10e8888abcd99yyyzzz85a5';
  const body = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fpm&text=RATES-12';
  const now = 1_700_000_000;

  it('accepts a correctly signed request within the skew window', () => {
    const sig = signSlackRequest(secret, body, now - 30);
    expect(verifySlackSignature(secret, body, String(now - 30), sig, now)).toBe(true);
  });

  it('rejects a wrong secret, a tampered body, a missing header and a stale timestamp', () => {
    const sig = signSlackRequest(secret, body, now);
    expect(verifySlackSignature('other', body, String(now), sig, now)).toBe(false);
    expect(verifySlackSignature(secret, body + '&x=1', String(now), sig, now)).toBe(false);
    expect(verifySlackSignature(secret, body, String(now), undefined, now)).toBe(false);
    const stale = signSlackRequest(secret, body, now - 6 * 60);
    expect(verifySlackSignature(secret, body, String(now - 6 * 60), stale, now)).toBe(false);
  });
});

describe('verifyGithubSignature', () => {
  const secret = 'It\'s a Secret to Everybody';
  const body = JSON.stringify({ action: 'opened', number: 1 });

  it('accepts sha256= signatures and rejects bad ones', () => {
    const sig = signGithubRequest(secret, body);
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifyGithubSignature(secret, body, sig)).toBe(true);
    expect(verifyGithubSignature(secret, body + ' ', sig)).toBe(false);
    expect(verifyGithubSignature('nope', body, sig)).toBe(false);
    expect(verifyGithubSignature(secret, body, undefined)).toBe(false);
    expect(verifyGithubSignature(secret, body, 'sha256=short')).toBe(false);
  });
});
