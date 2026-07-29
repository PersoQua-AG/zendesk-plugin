import { screenContent, type SecurityLevel } from '../security/screen.js';

type Preset = (data: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Cap recursion so a pathologically nested cached payload cannot blow the call stack.
// Inputs are already size-capped; legitimate Zendesk records nest far shallower than this.
const MAX_REPLAY_DEPTH = 100;

export interface ReplayScreen {
  value: unknown;
  flagged: boolean;
}

const PRESETS: Record<string, Preset> = {
  comments_slim: (data) => {
    const comments = isRecord(data) ? data.comments : undefined;
    if (!Array.isArray(comments)) return [];
    return comments.map((c) => {
      const record = isRecord(c) ? c : {};
      return { id: record.id, author_id: record.author_id, public: record.public, body: record.body };
    });
  },
  ids_only: (data) => {
    if (Array.isArray(data)) return data.map((item) => (isRecord(item) ? item.id : undefined));
    return isRecord(data) ? data.id : undefined;
  },
};

export function extractPath(data: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current: unknown = data;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    const arrayMatch = segment.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      const array = current[arrayMatch[1]];
      current = Array.isArray(array) ? array[Number(arrayMatch[2])] : undefined;
    } else {
      current = current[segment];
    }
  }
  return current;
}

export function runQuery(data: unknown, query: string): unknown {
  const preset = PRESETS[query];
  if (preset) return preset(data);
  return extractPath(data, query);
}

// Replay-boundary screen: the field-agnostic guarantee that NOTHING inbound reaches the
// model unscreened, independent of ingest field coverage. EVERY non-empty string is run
// through screenContent and wrapped in a fresh, unforgeable per-call nonce fence — wrapping
// does not depend on detection, so a payload that evades the pattern set (e.g. a token
// inserted mid-phrase) is still fenced. screenContent also redacts any forged envelope
// delimiter in its INPUT. There is deliberately NO "already fenced" fast-path: a substring an
// attacker can embed (e.g. `zendesk-content-`) must never let untrusted text skip screening;
// re-screening a genuinely-fenced string is safe (old delimiters redacted, re-fenced).
// Numbers/booleans/ids pass through untouched so structured extraction (ids_only, numeric
// dot-paths) stays usable.
export function screenReplay(value: unknown, level: SecurityLevel, depth = 0): ReplayScreen {
  if (level === 'off') return { value, flagged: false };
  if (depth > MAX_REPLAY_DEPTH) throw new Error('screenReplay: input nesting exceeds safe depth.');
  if (typeof value === 'string') {
    if (value === '') return { value, flagged: false };
    const { wrapped, flagged } = screenContent(value, 'query-replay', level);
    return { value: wrapped, flagged };
  }
  if (Array.isArray(value)) {
    let flagged = false;
    const out = value.map((item) => {
      const s = screenReplay(item, level, depth + 1);
      flagged = flagged || s.flagged;
      return s.value;
    });
    return { value: out, flagged };
  }
  if (isRecord(value)) {
    let flagged = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const s = screenReplay(v, level, depth + 1);
      flagged = flagged || s.flagged;
      out[k] = s.value;
    }
    return { value: out, flagged };
  }
  return { value, flagged: false };
}
