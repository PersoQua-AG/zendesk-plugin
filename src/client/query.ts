import { screenContent, type SecurityLevel } from '../security/screen.js';

type Preset = (data: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// A string already fenced upstream (ingest) carries this marker — do not re-screen it, or
// screenContent would redact its envelope delimiters. Keeps replay screening idempotent.
const FENCE_MARKER = 'zendesk-content-';

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
// model unscreened, independent of ingest field coverage. Recursively neutralize any
// string a zendesk_query extract returns before it is handed back. Already-fenced strings
// (screened at ingest) and benign strings pass through untouched; numbers/booleans/ids too.
export function screenReplay(value: unknown, level: SecurityLevel): ReplayScreen {
  if (level === 'off') return { value, flagged: false };
  if (typeof value === 'string') {
    if (value.includes(FENCE_MARKER)) return { value, flagged: false };
    const { wrapped, flagged } = screenContent(value, 'query-replay', level);
    return flagged ? { value: wrapped, flagged: true } : { value, flagged: false };
  }
  if (Array.isArray(value)) {
    let flagged = false;
    const out = value.map((item) => {
      const s = screenReplay(item, level);
      flagged = flagged || s.flagged;
      return s.value;
    });
    return { value: out, flagged };
  }
  if (isRecord(value)) {
    let flagged = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const s = screenReplay(v, level);
      flagged = flagged || s.flagged;
      out[k] = s.value;
    }
    return { value: out, flagged };
  }
  return { value, flagged: false };
}
