import { describe, it, expect, afterEach } from 'vitest';
import { startRemote, zendeskMock, type RemoteHarness } from './harness.js';
import { describeAuthError, CONNECTOR_AUTHORIZE_HINT } from '../../src/remote/error-messages.js';

let h: RemoteHarness | undefined;
afterEach(async () => {
  await h?.dispose();
  h = undefined;
});

describe('describeAuthError mapping (REQ-12)', () => {
  it('passes AuthManager and withAdminGuard copy through verbatim', () => {
    expect(describeAuthError(new Error('No Zendesk authorization found. Run the OAuth setup flow first.'))).toMatch(/No Zendesk authorization/);
    expect(describeAuthError(new Error('Updating a trigger requires an admin role — ...'))).toMatch(/admin role/);
  });

  it('maps an unauthorized/identity error to the connector-authorize hint', () => {
    expect(describeAuthError(new Error('invalid_token'))).toBe(CONNECTOR_AUTHORIZE_HINT);
    expect(describeAuthError(new Error('Authenticated session is missing a Zendesk identity.'))).toBe(CONNECTOR_AUTHORIZE_HINT);
  });
});

describe('remote auth/session failures surface actionable messages (REQ-12)', () => {
  it('an unauthorized (revoked/not-yet-authorized) identity surfaces the re-authorize message', async () => {
    h = await startRemote(zendeskMock({}), 'zendesk:1', /* seedToken */ false);
    await expect(h.callText('zendesk_search', { query: 'x', type: 'ticket' })).rejects.toThrow(/No Zendesk authorization|re-authorize/i);
  });

  it('an admin-gated write without the role surfaces the withAdminGuard message', async () => {
    const fetchImpl = zendeskMock({
      'POST /api/v2/triggers.json': () => new Response('Forbidden', { status: 403 }),
    });
    h = await startRemote(fetchImpl);
    await expect(h.callText('zendesk_create_trigger', { title: 'KPI trigger' })).rejects.toThrow(/requires an admin role/i);
  });
});
