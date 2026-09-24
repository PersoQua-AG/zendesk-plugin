import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupDirs, connect, fixtureEnv, textOf } from './harness.js';

afterEach(cleanupDirs);

// Fails on any divergence between commands/*.md and the hand-kept copy in src/register/prompts.ts.
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

// The $-patterns catch a body.replace that treats the value as a replacement pattern.
const SENTINEL = "SENTINEL-4711 $& $$ $' $`";

describe('prompts cannot drift from commands/*.md', () => {
  it('the prompt set equals the set of command files', async () => {
    const client = await connect(fixtureEnv());
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(commands.map((c) => c.name));
    await client.close();
  });

  it.each(commands)('$name: description, hint and body equal the command file', async (cmd) => {
    const client = await connect(fixtureEnv());
    const prompt = (await client.listPrompts()).prompts.find((p) => p.name === cmd.name);
    expect(prompt?.description).toBe(cmd.description);
    expect(prompt?.arguments).toHaveLength(1);
    expect(prompt?.arguments?.[0].description).toBe(cmd.hint);
    const result = await client.getPrompt({ name: cmd.name, arguments: { [prompt?.arguments?.[0].name ?? '']: SENTINEL } });
    expect(textOf(result)).toBe(cmd.body.split('$ARGUMENTS').join(SENTINEL));
    await client.close();
  });
});
