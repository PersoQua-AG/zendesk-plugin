import { describe, it, expect } from 'vitest';
import { generateCodeVerifier, generateCodeChallenge } from '../../src/auth/pkce.js';

describe('PKCE', () => {
  it('generates a verifier of sufficient length using URL-safe characters', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates distinct verifiers on each call', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it('derives a deterministic S256 challenge from a verifier', () => {
    const challenge = generateCodeChallenge('test-verifier-value');
    // Known SHA-256/base64url digest of 'test-verifier-value'
    expect(challenge).toBe('R-yFp3ykg184xTSr9BXHiHtbqWZXIG_H4B3K5EWSDzM');
  });

  it('challenge is URL-safe (no padding, +, or /)', () => {
    const challenge = generateCodeChallenge(generateCodeVerifier());
    expect(challenge).not.toMatch(/[+/=]/);
  });
});
