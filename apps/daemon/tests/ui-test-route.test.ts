import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';

describe('GET /_test', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = await startServer({ port: 0, returnServer: true }) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('returns 200', async () => {
    const res = await fetch(`${baseUrl}/_test`);
    expect(res.status).toBe(200);
  });

  it('returns text/html content type', async () => {
    const res = await fetch(`${baseUrl}/_test`);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('response body contains expected content', async () => {
    const res = await fetch(`${baseUrl}/_test`);
    const body = await res.text();
    expect(body).toContain('Open Design Daemon');
    expect(body).toContain('/api/version');
    expect(body).toContain('/api/projects');
  });
});
