/**
 * A real HTTP server standing in for an upstream.
 *
 * Tests exercise the actual fetch path — redirects, conditional requests,
 * Retry-After, streaming — rather than a mocked `fetch`, because the parts most
 * likely to break (redirect re-validation, 304 handling) live in that path.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RouteContext {
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  /** How many times this route has been hit. */
  hits: number;
}

export interface RouteResult {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Delay before responding, to exercise coalescing and timeouts. */
  delayMs?: number;
}

export type Route = (context: RouteContext) => RouteResult | Promise<RouteResult>;

export class FakeUpstream {
  private server: Server | undefined;
  private readonly routes = new Map<string, Route>();
  readonly hits = new Map<string, number>();
  port = 0;

  on(path: string, route: Route): this {
    this.routes.set(path, route);
    return this;
  }

  hitsFor(path: string): number {
    return this.hits.get(path) ?? 0;
  }

  get host(): string {
    return `127.0.0.1:${this.port}`;
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1`);
      const route = this.routes.get(url.pathname);
      const hits = (this.hits.get(url.pathname) ?? 0) + 1;
      this.hits.set(url.pathname, hits);

      if (!route) {
        response.writeHead(404).end('not found');
        return;
      }

      void Promise.resolve(route({ url, headers: request.headers, hits })).then((result) => {
        const finish = (): void => {
          response.writeHead(result.status ?? 200, {
            'content-type': 'text/plain; charset=utf-8',
            ...result.headers,
          });
          response.end(result.body ?? '');
        };
        if (result.delayMs) setTimeout(finish, result.delayMs);
        else finish();
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    this.port = (this.server!.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }
}
