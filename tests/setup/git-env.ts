// A hook exports GIT_INDEX_FILE, and GIT_DIR in a linked worktree; a test's git call that inherits
// them works on the outer repository instead of the one `cwd` names. Read per call, not once at
// load, so a variable set after load is filtered too. One copy, so the decoy case in
// tests/plugin/bound-port-literals-guard.test.ts pins the filter every caller uses.
export const gitEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
