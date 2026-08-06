// Minimal ambient typings for the express runtime that ships transitively with the MCP SDK.
// The SDK's OAuth router + bearer middleware are express-based, but @types/express is not
// installed (and adding it is out of scope). This shim types only the surface this repo uses.
// Request/Response extend the node:http primitives so express handlers satisfy the SDK's
// StreamableHTTPServerTransport.handleRequest(req: IncomingMessage, res: ServerResponse).
declare module 'express' {
  import type { IncomingMessage, ServerResponse } from 'node:http';
  import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

  export interface Request extends IncomingMessage {
    body?: unknown;
    auth?: AuthInfo;
    query: Record<string, string | string[] | undefined>;
  }
  export interface Response extends ServerResponse {
    json(body: unknown): Response;
    status(code: number): Response;
    redirect(url: string): void;
  }
  export type NextFunction = (err?: unknown) => void;
  export type RequestHandler = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

  export interface Application {
    use(...handlers: (RequestHandler | unknown)[]): Application;
    get(path: string, ...handlers: RequestHandler[]): Application;
    post(path: string, ...handlers: RequestHandler[]): Application;
    delete(path: string, ...handlers: RequestHandler[]): Application;
    listen(port: number, cb?: () => void): unknown;
  }
  interface ExpressFactory {
    (): Application;
    json(opts?: { limit?: string }): RequestHandler;
  }
  const express: ExpressFactory;
  export default express;
}
