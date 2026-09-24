import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupDirs, connect, fixtureEnv, textOf } from './harness.js';

afterEach(cleanupDirs);

// commands/*.md is the Claude Code source of truth; the MCP prompts are a hand-written copy in
// src/register/prompts.ts. This suite reads both and fails on any divergence.
const commandsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands');

interface CommandFile {
  name: string;
  description: string;
  hint: string;
  body: string;
}

function readCommand(file: string): CommandFile {
  const text = readFileSync(join(commandsDir, file), 'utf8');
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: no frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return { name: file.replace(/\.md$/, ''), description: fields.description, hint: fields['argument-hint'], body: m[2].trim() };
}

const commands = readdirSync(commandsDir)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map(readCommand);

const SENTINEL = 'SENTINEL-4711';

describe('prompts cannot drift from commands/*.md', () => {
  it('the prompt set equals the set of command files', async () => {
    const client = await connect(fixtureEnv());
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(commands.map((c) => c.name));
    await client.close();
  });

  it.each(commands)('$name: description and argument hint equal the frontmatter', async (cmd) => {
    const client = await connect(fixtureEnv());
    const prompt = (await client.listPrompts()).prompts.find((p) => p.name === cmd.name);
    expect(prompt?.description).toBe(cmd.description);
    expect(prompt?.arguments).toHaveLength(1);
    expect(prompt?.arguments?.[0].description).toBe(cmd.hint);
    expect(prompt?.arguments?.[0].required).toBe(!cmd.hint.startsWith('['));
    await client.close();
  });

  it.each(commands)('$name: body is the command body verbatim apart from the argument placeholder', async (cmd) => {
    const client = await connect(fixtureEnv());
    const argName = (await client.listPrompts()).prompts.find((p) => p.name === cmd.name)?.arguments?.[0].name ?? '';
    const result = await client.getPrompt({ name: cmd.name, arguments: { [argName]: SENTINEL } });
    expect(textOf(result)).toBe(cmd.body.replaceAll('$ARGUMENTS', SENTINEL));
    await client.close();
  });
});
