// The async sibling of the `thrown<T>()` helper in refresh-grant.test.ts (#57).
//
// WHAT IT REPLACES. `(await p.catch((e: unknown) => e)) as Error` is a CAST, not a narrowing. When
// the promise RESOLVES — which is the failure the assertion below it exists to catch — the cast
// says nothing, the resolved value flows on as an `Error`, and the test dies on
// `Cannot read properties of undefined (reading 'message')` at the next line. The reader is then
// debugging a TypeError in the test instead of reading "this was supposed to reject and did not".
//
// So this asserts the rejection first and narrows afterwards, and it names both ways it can be
// disappointed: a promise that resolved, and a rejection that is not an Error. The label is the
// caller's, because by the time the message is read the expression that produced it is gone.
export async function rejection(label: string, promise: Promise<unknown>): Promise<Error> {
  const RESOLVED = Symbol('resolved');
  const outcome: unknown = await promise.then(
    () => RESOLVED,
    (e: unknown) => e,
  );
  if (outcome === RESOLVED) throw new Error(`expected ${label} to reject, and it resolved`);
  if (!(outcome instanceof Error)) {
    throw new Error(`expected ${label} to reject with an Error, got ${typeof outcome}: ${String(outcome)}`);
  }
  return outcome;
}
