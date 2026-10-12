// A hook exports GIT_INDEX_FILE, and GIT_DIR in a linked worktree; a test's git call that inherits
// them works on the outer repository instead of the one `cwd` names. The default is read per call,
// so a variable set after load is filtered too. Pinned by the decoy case in
// tests/plugin/bound-port-literals-guard.test.ts, which covers every caller of this one copy.
export const gitEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('GIT_')));
