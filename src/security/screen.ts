import { randomBytes } from 'node:crypto';

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /you\s+are\s+now\s+(in\s+)?(developer|admin|debug)\s+mode/i,
  /system\s*:\s*override/i,
  /\[\[?system\]?\]/i,
];

// strict mode adds chat-role and tool-call spoofing heuristics on top.
const STRICT_PATTERNS: RegExp[] = [
  /<\/?(system|assistant|user)>/i,
  /begin\s+system\s+prompt/i,
  /\b(tool_call|function_call)\b/i,
];

// Any occurrence of our envelope delimiter inside untrusted text — a breakout attempt.
const DELIMITER_PATTERN = /<\/?zendesk-content[^>]*>/gi;
const DELIMITER_REDACTION = '[redacted-delimiter]';

export type SecurityLevel = 'strict' | 'standard' | 'off';

export interface ScreenResult {
  flagged: boolean;
  matchedPatterns: string[];
  wrapped: string;
}

export function screenContent(
  text: string,
  sourceLabel: string,
  securityLevel: SecurityLevel = 'standard',
): ScreenResult {
  if (securityLevel === 'off') {
    return { flagged: false, matchedPatterns: [], wrapped: text };
  }

  const attemptedBreakout = text.match(DELIMITER_PATTERN) !== null;
  // Strip forged delimiters so a ticket body cannot close our envelope early.
  const neutralized = text.replace(DELIMITER_PATTERN, DELIMITER_REDACTION);

  const patterns = securityLevel === 'strict' ? [...INJECTION_PATTERNS, ...STRICT_PATTERNS] : INJECTION_PATTERNS;
  const matched = patterns.filter((pattern) => pattern.test(neutralized)).map((pattern) => pattern.source);
  if (securityLevel === 'strict' && attemptedBreakout) {
    matched.push('delimiter-breakout-attempt');
  }

  // Nonce-suffixed delimiter the untrusted text cannot predict or forge.
  const nonce = randomBytes(6).toString('hex');
  const marker = `zendesk-content-${sourceLabel}-${nonce}`;
  const wrapped = `<${marker}>\n${neutralized}\n</${marker}>`;
  return { flagged: matched.length > 0, matchedPatterns: matched, wrapped };
}
