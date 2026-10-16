import { resolveAuthConfig } from '../../src/auth/config.js';
import type { keychain } from './keychain.js';

// What the resolver itself says is wrong with this env: the truth a degraded answer is checked against.
export function diagnosisOf(env: NodeJS.ProcessEnv, security: ReturnType<typeof keychain>): string {
  try {
    resolveAuthConfig(env, security);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('this env resolves, so nothing is missing');
}
