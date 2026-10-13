// fs and other Node errors carry the absolute path; only the code may reach the model or the log.
export function errorCode(err: unknown): string {
  return err instanceof Error && 'code' in err ? String(err.code) : 'unknown error';
}
