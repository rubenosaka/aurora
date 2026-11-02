import { createHash, randomBytes } from 'node:crypto';

export function createPkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function pkceChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}
