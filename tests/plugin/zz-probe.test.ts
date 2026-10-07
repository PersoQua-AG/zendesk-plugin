import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import { isDeclaredPort, takeRefusals, allowForeignBind } from '../setup/acquired-ports.js';

const open: Server[] = [];
async function tryBind(label: string, go: () => Server): Promise<void> {
  let refused: string | null = null;
  let addr: unknown = null;
  try {
    const s = go();
    open.push(s);
    await new Promise<void>((ok, bad) => {
      s.on('error', bad);
      s.on('listening', () => ok());
      setTimeout(() => ok(), 800);
    });
    addr = s.address();
  } catch (e) {
    refused = (e as Error).message.split('\n')[0];
  }
  takeRefusals();
  console.log(`PROBE ${label} :: refused=${refused ? JSON.stringify(refused) : 'NO'} :: addr=${JSON.stringify(addr)}`);
}

describe('zz probe', () => {
  it('shapes', async () => {
    await tryBind('{handle:undefined,port:18106}', () => createServer().listen({ handle: undefined, port: 18106, host: '127.0.0.1' } as never));
    await tryBind('{fd:-1,port:18107}', () => createServer().listen({ fd: -1, port: 18107, host: '127.0.0.1' } as never));
    await tryBind('{handle:0,port:18108}', () => createServer().listen({ handle: 0, port: 18108, host: '127.0.0.1' } as never));
    await tryBind('{handle:false,port:18109}', () => createServer().listen({ handle: false, port: 18109, host: '127.0.0.1' } as never));
    await tryBind('{fd:NaN,port:18110}', () => createServer().listen({ fd: NaN, port: 18110, host: '127.0.0.1' } as never));
    await tryBind('{port:0}', () => createServer().listen({ port: 0, host: '127.0.0.1' } as never));
    await tryBind("listen('0')", () => createServer().listen('0' as never));
    await tryBind("listen(' 8976 ')", () => createServer().listen(' 8976 ' as never));
    await tryBind("listen('0x4650')", () => createServer().listen('0x4650' as never));
    await tryBind('listen(70000)', () => createServer().listen(70000));
    await tryBind('listen(cb)', () => createServer().listen(() => {}));
    await tryBind('listen()', () => createServer().listen());
    expect(true).toBe(true);
  }, 30000);

  it('positional handle + registration', async () => {
    const p = 18111;
    allowForeignBind(p, 'probe');
    const held = createServer().listen(p, '127.0.0.1');
    open.push(held);
    await new Promise<void>((ok) => held.on('listening', () => ok()));
    takeRefusals();
    const h = (held as unknown as { _handle: unknown })._handle;
    console.log(`PROBE handle keys :: ${JSON.stringify(Object.keys(h as object))} fd=${(h as {fd?:unknown}).fd}`);
    // positional handle
    let refused: string | null = null;
    try {
      const s2 = createServer();
      open.push(s2);
      (s2.listen as (a: unknown, cb: () => void) => void)(h, () => {});
      await new Promise<void>((ok) => setTimeout(ok, 400));
      console.log(`PROBE positional-handle addr=${JSON.stringify(s2.address())}`);
    } catch (e) { refused = (e as Error).message.split('\n')[0]; }
    takeRefusals();
    console.log(`PROBE positional-handle refused=${refused ? JSON.stringify(refused) : 'NO'}`);
  }, 30000);

  it('declared after each shape', async () => {
    for (const p of [18106,18107,18108,18109,18110,18111]) {
      console.log(`PROBE declared(${p})=${isDeclaredPort(p)}`);
    }
    for (const s of open.splice(0)) await new Promise<void>((d) => s.close(() => d()));
  });

  it('path bag', async () => {
    await tryBind("{path:'/tmp/zzprobe.sock',port:18112}", () => createServer().listen({ path: '/tmp/zzprobe-' + process.pid + '.sock', port: 18112 } as never));
    for (const s of open.splice(0)) await new Promise<void>((d) => s.close(() => d()));
  }, 30000);
});
