import { randomBytes } from 'node:crypto';

// High-severity, low-false-positive injection patterns — flagged on the DEFAULT
// `standard` level (not merely delimiter-neutralized). Includes role-spoof,
// system-prompt-boundary, and tool-call forgery attempts.
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior|above)/i,
  /you\s+are\s+now\s+(in\s+)?(developer|admin|debug)\s+mode/i,
  /system\s*:\s*override/i,
  /\[\[?system\]?\]/i,
  /begin\s+system\s+prompt/i,
  /\b(tool_call|function_call)\b/i,
];

// strict mode adds broader (higher-false-positive) chat-role heuristics on top —
// e.g. a bare <assistant> mention, which is often benign in ordinary text.
const STRICT_PATTERNS: RegExp[] = [
  /<\/?(system|assistant|user)>/i,
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
  const attemptedBreakout = text.match(DELIMITER_PATTERN) !== null;
  // Strip forged delimiters so a ticket body cannot close our envelope early.
  const neutralized = text.replace(DELIMITER_PATTERN, DELIMITER_REDACTION);

  const patterns = securityLevel === 'strict' ? [...INJECTION_PATTERNS, ...STRICT_PATTERNS] : INJECTION_PATTERNS;
  const matched = patterns.filter((pattern) => pattern.test(neutralized)).map((pattern) => pattern.source);
  if (securityLevel === 'strict' && attemptedBreakout) {
    matched.push('delimiter-breakout-attempt');
  }

  // `off` opts out of the FENCE alone, not of the boundary: forged delimiters are still stripped
  // and patterns still detected, so the caller can still warn (owner decision on #59, 2026-10-06).
  if (securityLevel === 'off') {
    return { flagged: matched.length > 0, matchedPatterns: matched, wrapped: neutralized };
  }

  // Nonce-suffixed delimiter the untrusted text cannot predict or forge.
  const nonce = randomBytes(6).toString('hex');
  const marker = `zendesk-content-${sourceLabel}-${nonce}`;
  const wrapped = `<${marker}>\n${neutralized}\n</${marker}>`;
  return { flagged: matched.length > 0, matchedPatterns: matched, wrapped };
}
