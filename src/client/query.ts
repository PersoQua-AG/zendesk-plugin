type Preset = (data: unknown) => unknown;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
