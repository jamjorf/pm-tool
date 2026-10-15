import { createHmac, timingSafeEqual } from 'node:crypto';

/** GitHub webhook signature: `X-Hub-Signature-256: sha256=<hex hmac-sha256(secret, rawBody)>`. */
export function verifyGithubSignature(secret: string, rawBody: string | Buffer, signatureHeader: string | undefined): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = signGithubRequest(secret, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signGithubRequest(secret: string, rawBody: string | Buffer): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}
