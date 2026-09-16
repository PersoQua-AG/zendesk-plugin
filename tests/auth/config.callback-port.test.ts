import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CALLBACK_PORT,
  MIN_CALLBACK_PORT,
  resolveAuthConfig,
  stripPlaceholders,
} from '../../src/auth/config.js';

const fullEnv = (): NodeJS.ProcessEnv => ({
  ZENDESK_SUBDOMAIN: 'acme',
  ZENDESK_OAUTH_CLIENT_ID: 'client-abc',
  ZENDESK_OAUTH_CLIENT_SECRET: 'secret-xyz',
});

const withPort = (value: string): NodeJS.ProcessEnv => ({ ...fullEnv(), ZENDESK_OAUTH_CALLBACK_PORT: value });

// Rejected, not clamped. A clamped port is still bound and still advertised, so the user sees an
// authorization that fails at Zendesk's redirect-mismatch check with nothing naming the cause;
// a rejected one names the field to fix before anything is bound at all.
describe('callback port validation', () => {
  it.each([
    ['above the maximum', '70000'],
    ['one past the maximum', '65536'],
    ['one below the minimum', '1023'],
    ['zero — would bind a RANDOM port while the URL advertises :0/callback', '0'],
    ['negative', '-1'],
    ['not a whole number', '8976.5'],
    ['not a number at all', 'eight-thousand'],
  ])('rejects a port that is %s', (_label, value) => {
    expect(() => resolveAuthConfig(withPort(value))).toThrow(
      `Invalid environment variable: ZENDESK_OAUTH_CALLBACK_PORT="${value}" (extension configuration field ` +
        '"oauth_callback_port" must be a whole number between 1024 and 65535).',
    );
  });

  it.each([
    ['the lowest unprivileged port', '1024', 1024],
    ['the highest existing port', '65535', 65535],
    ['an ordinary port', '9000', 9000],
  ])('accepts %s', (_label, value, expected) => {
    expect(resolveAuthConfig(withPort(value)).config.callbackPort).toBe(expected);
  });

  // Unchanged, and deliberately so: an optional user_config field the user left blank arrives as the
  // literal ${...} placeholder, which stripPlaceholders makes ABSENT. Absent is not invalid — it is
  // the shipped default. Rejecting it would make the untouched extension refuse to start.
  it('still treats a blank and a placeholder callback port as absent, not as invalid', () => {
    expect(resolveAuthConfig(withPort('')).config.callbackPort).toBe(8976);
    const raw = withPort('${user_config.oauth_callback_port}');
    expect(stripPlaceholders(raw).ZENDESK_OAUTH_CALLBACK_PORT).toBeUndefined();
    expect(resolveAuthConfig(raw).config.callbackPort).toBe(8976);
  });

  // The manifests declare the same range to their hosts, which is the layer that can refuse the
  // value in the settings dialog before the server ever runs. Driven off the code constants so a
  // range changed in one place fails here instead of drifting silently.
  it('is the same range both manifests declare as min/max on oauth_callback_port', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const read = (rel: string) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
    for (const [rel, field] of [
      ['manifest.json', read('manifest.json').user_config.oauth_callback_port],
      ['.claude-plugin/plugin.json', read('.claude-plugin/plugin.json').userConfig.oauth_callback_port],
    ] as const) {
      expect(field.min, `${rel} min`).toBe(MIN_CALLBACK_PORT);
      expect(field.max, `${rel} max`).toBe(MAX_CALLBACK_PORT);
    }
  });
});
