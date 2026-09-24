import { describe, it, expect, vi } from 'vitest';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const connect = vi.fn();
vi.mock('../../src/server.js', () => ({ createServer: () => ({ server: { connect } }) }));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: class {} }));

describe('plugin stdio entry', () => {
  it('connects the server to stdio on import, without a main-module check', async () => {
    await import('../../src/plugin/stdio.js');
    expect(connect).toHaveBeenCalledOnce();
    expect(connect.mock.calls[0][0]).toBeInstanceOf(StdioServerTransport);
  });
});
