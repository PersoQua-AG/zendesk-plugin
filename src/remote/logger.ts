// Structured JSON line to stderr with token/secret redaction (extends the M8 secret-safe-logging
// guarantee to the remote path). Bodies/PII are never passed in by contract — callers pass ids and
// outcomes, not ticket content — and any bearer token or secret-shaped blob that slips into a
// message is redacted before it can reach a log sink.
const REDACT = /(bearer\s+[\w.\-]+)|([A-Za-z0-9_\-]{24,})/gi;

export interface LogFields {
  outcome?: string;
  msg: string;
}

export function log(fields: LogFields): void {
  const line = JSON.stringify(fields).replace(REDACT, '[redacted]');
  process.stderr.write(line + '\n');
}
