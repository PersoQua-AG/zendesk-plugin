// tests/plugin/process-fence.ts
// Shuts every route from a module to a new process that this suite knows, for one window. Each function
// export of node:child_process is replaced on the one object that `import`, `import()`, `require` and
// `createRequire` all resolve to, and syncBuiltinESMExports pushes that into the ESM bindings, so those
// calls go to `fake`. process.binding, process.execve, process.dlopen and worker_threads.Worker go around
// that object, so they throw and are recorded in `opened`. Both halves are checked before this returns.
// Not shut: a native addon loaded before the window, a process started outside it, and a child_process
// function a module took off the object before the window; import the code under test only inside it.
import { createRequire, syncBuiltinESMExports } from 'node:module';

type Door = [Record<string, unknown>, string];

export async function fenceProcesses(
  fake: (name: string, file: unknown, args: unknown, options: unknown) => unknown,
): Promise<{ opened: string[]; restore: () => void }> {
  const load = createRequire(import.meta.url);
  const cp = load('node:child_process') as Record<string, unknown>;
  const wt = load('node:worker_threads') as Record<string, unknown>;
  const proc = process as unknown as Record<string, unknown>;
  const routed: Door[] = Object.keys(cp).filter((k) => typeof cp[k] === 'function').map((k) => [cp, k]);
  const shut: Door[] = [[proc, 'binding'], [proc, 'execve'], [proc, 'dlopen'], [wt, 'Worker']];
  const saved = [...routed, ...shut].map(([o, k]) => [o, k, o[k]] as const);
  const opened: string[] = [];
  const restore = () => {
    for (const [o, k, v] of saved) {
      if (v === undefined) delete o[k];
      else o[k] = v;
    }
    syncBuiltinESMExports();
  };
  // `function`, not an arrow: `new ChildProcess()` and `new Worker()` must land here too.
  for (const [o, k] of routed) o[k] = function (file: unknown, args?: unknown, options?: unknown) { return fake(k, file, args, options); };
  for (const [o, k] of shut) o[k] = function () { opened.push(k); throw new Error(`${k} refused`); };
  syncBuiltinESMExports();

  for (const [o, k] of shut) {
    try { (o[k] as () => void)(); } catch { /* recorded */ }
  }
  const esm = [(await import('node:child_process')).execFileSync === cp.execFileSync, (await import('node:worker_threads')).Worker === wt.Worker];
  if (opened.length !== shut.length || esm.includes(false)) {
    restore();
    throw new Error(`the process fence did not hold: opened ${opened}, ESM bindings ${esm}`);
  }
  opened.length = 0;
  return { opened, restore };
}
