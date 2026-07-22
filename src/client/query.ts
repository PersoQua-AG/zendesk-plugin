type Preset = (data: any) => unknown;

const PRESETS: Record<string, Preset> = {
  comments_slim: (data: any) =>
    (data.comments ?? []).map((c: any) => ({ id: c.id, author_id: c.author_id, public: c.public, body: c.body })),
  ids_only: (data: any) => (Array.isArray(data) ? data.map((item: any) => item.id) : data.id),
};

export function extractPath(data: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current: any = data;
  for (const segment of segments) {
    if (current == null) return undefined;
    const arrayMatch = segment.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      current = current[arrayMatch[1]]?.[Number(arrayMatch[2])];
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
