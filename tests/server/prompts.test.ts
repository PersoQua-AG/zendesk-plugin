import { describe, it, expect, afterEach } from 'vitest';
import { cleanupDirs, connect, fixtureEnv, textOf, unconfiguredEnv } from './harness.js';
import { startRemote, zendeskMock } from '../server-remote/harness.js';

afterEach(cleanupDirs);

const NAMES = ['escalate', 'report', 'search', 'ticket', 'tickets'];

describe('MCP prompts (issue #31)', () => {
  it('advertises the prompts capability after initialize', async () => {
    const client = await connect(fixtureEnv());
    expect(client.getServerCapabilities()?.prompts).toBeDefined();
    await client.close();
  });

  it('lists exactly the five packaged workflows, each with a non-empty description', async () => {
    const client = await connect(fixtureEnv());
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(NAMES);
    for (const p of prompts) expect(p.description?.trim()).toBeTruthy();
    await client.close();
  });

  it('declares the argument each argument-hint names; only the bracketed tickets filter is optional', async () => {
    const client = await connect(fixtureEnv());
    const { prompts } = await client.listPrompts();
    const shape = Object.fromEntries(
      prompts.map((p) => [p.name, (p.arguments ?? []).map((a) => ({ name: a.name, required: a.required }))]),
    );
    expect(shape).toEqual({
      ticket: [{ name: 'id', required: true }],
      escalate: [{ name: 'id', required: true }],
      search: [{ name: 'query', required: true }],
      report: [{ name: 'range', required: true }],
      tickets: [{ name: 'filter', required: false }],
    });
    await client.close();
  });

  it('returns the ticket workflow as a user message with the id substituted and no frontmatter', async () => {
    const client = await connect(fixtureEnv());
    const result = await client.getPrompt({ name: 'ticket', arguments: { id: '12345' } });
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages.every((m) => m.role === 'user')).toBe(true);
    const text = textOf(result);
    expect(text).toContain('Show ticket **12345** in full.');
    expect(text).not.toContain('$ARGUMENTS');
    expect(text).not.toMatch(/^---$/m);
    expect(text).not.toMatch(/argument-hint|disable-model-invocation/);
    await client.close();
  });

  it('rejects an unknown prompt with a JSON-RPC error and keeps answering', async () => {
    const client = await connect(fixtureEnv());
    await expect(client.getPrompt({ name: 'nope' })).rejects.toMatchObject({ code: -32602 });
    const { prompts } = await client.listPrompts();
    expect(prompts).toHaveLength(5);
    await client.close();
  });

  it('rejects ticket without arguments with an error naming the missing id', async () => {
    const client = await connect(fixtureEnv());
    for (const request of [{ name: 'ticket' }, { name: 'ticket', arguments: {} }]) {
      const err = await client.getPrompt(request).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: -32602 });
      expect(String((err as Error).message)).toContain('"id"');
    }
    expect((await client.listPrompts()).prompts).toHaveLength(5);
    await client.close();
  });

  it('treats an empty or blank search query as no query: the stop instruction applies, nothing is claimed', async () => {
    const client = await connect(fixtureEnv());
    for (const query of ['', '   ']) {
      const text = textOf(await client.getPrompt({ name: 'search', arguments: { query } }));
      expect(text).toContain('Search Zendesk for: ****.');
      expect(text).not.toContain('$ARGUMENTS');
      const stop = text.indexOf('If the query is empty, ask what to search for and stop.');
      expect(stop).toBeGreaterThan(-1);
      expect(stop).toBeLessThan(text.indexOf('zendesk_search'));
    }
    await client.close();
  });

  it('substitutes an omitted optional tickets filter with nothing, so the trim-to-status<solved rule applies', async () => {
    const client = await connect(fixtureEnv());
    const text = textOf(await client.getPrompt({ name: 'tickets' }));
    expect(text).toContain('`status<solved `');
    expect(text).toContain('trim to `status<solved` if no argument was given');
    expect(text).not.toContain('$ARGUMENTS');
    await client.close();
  });

  it('lists the five prompts on a server with no Zendesk credentials', async () => {
    const client = await connect(unconfiguredEnv());
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(NAMES);
    await client.close();
  });

  it.each(['$&', '$$100', "$'", '$`'])('renders the search query %s verbatim, not as a replacement pattern', async (query) => {
    const client = await connect(fixtureEnv());
    const text = textOf(await client.getPrompt({ name: 'search', arguments: { query } }));
    expect(text).toContain(`Search Zendesk for: **${query}**.`);
    expect(text).not.toContain('$ARGUMENTS');
    await client.close();
  });
});

describe('prompt-surface parity (remote vs stdio)', () => {
  it('a SessionManager-built server over HTTP lists the same prompts as stdio and renders ticket 7', async () => {
    const stdioClient = await connect(fixtureEnv());
    const stdio = (await stdioClient.listPrompts()).prompts;
    await stdioClient.close();
    const remote = await startRemote(zendeskMock({}));
    try {
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
      expect(stdio).toHaveLength(5);
      expect((await remote.client.listPrompts()).prompts.sort(byName)).toEqual(stdio.sort(byName));
      const text = textOf(await remote.client.getPrompt({ name: 'ticket', arguments: { id: '7' } }));
      expect(text).toContain('Show ticket **7** in full.');
    } finally {
      await remote.dispose();
    }
  });
});
