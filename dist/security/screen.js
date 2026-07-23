import { randomBytes } from 'node:crypto';
// High-severity, low-false-positive injection patterns — flagged on the DEFAULT
// `standard` level (not merely delimiter-neutralized). Includes role-spoof,
// system-prompt-boundary, and tool-call forgery attempts.
const INJECTION_PATTERNS = [
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
const STRICT_PATTERNS = [
    /<\/?(system|assistant|user)>/i,
];
// Any occurrence of our envelope delimiter inside untrusted text — a breakout attempt.
const DELIMITER_PATTERN = /<\/?zendesk-content[^>]*>/gi;
const DELIMITER_REDACTION = '[redacted-delimiter]';
export function screenContent(text, sourceLabel, securityLevel = 'standard') {
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
