const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /you\s+are\s+now\s+(in\s+)?(developer|admin|debug)\s+mode/i,
  /system\s*:\s*override/i,
  /\[\[?system\]?\]/i,
];

export interface ScreenResult {
  flagged: boolean;
  matchedPatterns: string[];
  wrapped: string;
}

export function screenContent(text: string, sourceLabel: string): ScreenResult {
  const matched = INJECTION_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  const marker = `zendesk-content-${sourceLabel}`;
  const wrapped = `<${marker}>\n${text}\n</${marker}>`;
  return { flagged: matched.length > 0, matchedPatterns: matched, wrapped };
}
