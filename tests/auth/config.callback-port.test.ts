import { describe, it, expect } from 'vitest';
import { callbackPortOrDefault, resolveAuthConfig, stripPlaceholders } from '../../src/auth/config.js';
import { keychain } from './keychain.js';

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
    expect(() => resolveAuthConfig(withPort(value), keychain())).toThrow(
      `Invalid environment variable: ZENDESK_OAUTH_CALLBACK_PORT="${value}" (extension configuration field ` +
        '"oauth_callback_port" must be a whole number between 1024 and 65535).',
    );
  });

  it.each([
    ['the lowest unprivileged port', '1024', 1024],
    ['the highest existing port', '65535', 65535],
    ['an ordinary port', '9000', 9000],
  ])('accepts %s', (_label, value, expected) => {
    expect(resolveAuthConfig(withPort(value), keychain()).config.callbackPort).toBe(expected);
  });

  // Unchanged, and deliberately so: an optional user_config field the user left blank arrives as the
  // literal ${...} placeholder, which stripPlaceholders makes ABSENT. Absent is not invalid — it is
  // the shipped default. Rejecting it would make the untouched extension refuse to start.
  it('still treats a blank and a placeholder callback port as absent, not as invalid', () => {
    expect(resolveAuthConfig(withPort(''), keychain()).config.callbackPort).toBe(8976);
    const raw = withPort('${user_config.oauth_callback_port}');
    expect(stripPlaceholders(raw).ZENDESK_OAUTH_CALLBACK_PORT).toBeUndefined();
    expect(resolveAuthConfig(raw, keychain()).config.callbackPort).toBe(8976);
  });

  // A manifest used to declare the same range as min/max to its host, which could refuse an
  // out-of-range value in a settings dialog before the server ever ran. Both declarations are gone:
  // .claude-plugin/plugin.json carries no user_config at all since #68 (the Claude Code host bridge
  // does not support one), and manifest.json went with the retired MCPB path (#103). The server's
  // own validation is the only layer left, which is what the cases above measure — the bounds are
  // pinned by the rejection message and by the 1024/65535 acceptance cases, not by a manifest.
});

// The port a start that could not resolve the REST serves its setup page on. It used to be the shipped
// default whatever the environment said, because resolveAuthConfig validates the subdomain first and
// throws there — and the one person who sets a different port does so because 8976 is taken, which is
// both the port the page would have told them to register and the one it could not bind.
describe('the callback port when nothing else resolves', () => {
  it('is the configured one, with nothing to report', () => {
    expect(callbackPortOrDefault({ ZENDESK_OAUTH_CALLBACK_PORT: '21224' })).toEqual({ port: 21224 });
    expect(callbackPortOrDefault({})).toEqual({ port: 8976 });
  });

  // The port is validated AFTER the subdomain, so the reason a degraded start reports is almost never about
  // the port — and a port nobody mentions is a redirect URL the person registers wrong, finishes setup
  // with, and whose next start fails. So the fallback carries the problem with it.
  it('reports the problem when the configured one is unusable, naming value and field', () => {
    for (const value of ['70000', 'eighty', '80']) {
      const { port, problem } = callbackPortOrDefault({ ZENDESK_OAUTH_CALLBACK_PORT: value });
      expect(port, value).toBe(8976);
      expect(problem, value).toContain(`ZENDESK_OAUTH_CALLBACK_PORT="${value}"`);
      expect(problem, value).toContain('oauth_callback_port');
      expect(problem, value).toContain('8976');
    }
  });
});
