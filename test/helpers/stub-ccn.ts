import { createServer } from "node:http";
import type { AlephMessage } from "../../src/types.js";

export interface StubRoutes {
  messages: (url: URL) => { messages: AlephMessage[]; pagination_total?: number };
  message?: (hash: string) => { status: number; body: unknown };
  raw?: (hash: string) => Buffer | null;
}

const MESSAGE_PREFIX = "/api/v0/messages/";
const RAW_PREFIX = "/api/v0/storage/raw/";

function notFound(res: import("node:http").ServerResponse): void {
  res.writeHead(404).end();
}

/** A CCN stand-in on 127.0.0.1:0 serving the three endpoints the recovery script reads. */
export async function startStubCcn(
  routes: StubRoutes,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/v0/messages.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(routes.messages(url)));
      return;
    }
    if (url.pathname.startsWith(MESSAGE_PREFIX) && routes.message) {
      const reply = routes.message(url.pathname.slice(MESSAGE_PREFIX.length));
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
      return;
    }
    if (url.pathname.startsWith(RAW_PREFIX) && routes.raw) {
      const bytes = routes.raw(url.pathname.slice(RAW_PREFIX.length));
      if (bytes === null) return notFound(res);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(bytes);
      return;
    }
    notFound(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("stub CCN did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
