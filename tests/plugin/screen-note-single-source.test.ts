// tests/plugin/screen-note-single-source.test.ts
// #59 made screenNote() the one place that decides what a tool result says about screening: the
// off-notice rides along at `off`, the warning rides on a detected pattern. Nothing in the code
// stops the next tool from importing SCREEN_WARNING straight from screening.ts and writing
// `flagged ? SCREEN_WARNING : ''` by hand again — which is what all ~20 call sites did before, and
// it is silently HALF the contract: such a tool never announces `security_level=off`.
//
// Measured, not assumed (QA control run, 2026-10-06): reverting src/tools/orgs.ts:63 to
// `flagged ? SCREEN_WARNING : ''` leaves the rest of the suite green — 1382 passed, this guard the
// only failure — while zendesk_get_org loses the off-notice. No behavioural test catches it either:
// the notice's absence is visible only if you already know to look for it on that one tool. So it
// is pinned structurally: the two message constants are named in the file that defines them and
// nowhere else under src/. Tests may import them freely; only src/ is scanned.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const NOTE_SOURCE = 'tools/screening.ts';
const RAW_NOTE = /SCREEN_WARNING|SCREEN_OFF_NOTICE/;

function srcFiles(): string[] {
  return readdirSync(SRC, { recursive: true })
    .map((p) => String(p).split('\\').join('/'))
    .filter((p) => p.endsWith('.ts'));
}

describe('the screening note has one source', () => {
  it('names the note constants in exactly one file, the one that defines them', () => {
    const mentions = srcFiles().filter((rel) => RAW_NOTE.test(readFileSync(join(SRC, rel), 'utf8')));
    expect(mentions).toEqual([NOTE_SOURCE]);
  });
});
