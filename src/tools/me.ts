import type { ZendeskHttpClient } from '../client/http-client.js';
import type { ResponseCache } from '../client/cache.js';

export interface ZendeskUser {
  id: number;
  name: string;
  email: string;
  role: string;
}

export async function getMe(
  client: ZendeskHttpClient,
  cache: ResponseCache,
): Promise<{ summary: string; cacheHandle: string }> {
  const data = await client.request<{ user: ZendeskUser }>('/users/me.json');
  const entry = cache.save('zendesk_get_me', data);
  const { user } = data;
  return {
    summary: `Authenticated as ${user.name} <${user.email}> — role: ${user.role}`,
    cacheHandle: entry.handle,
  };
}
