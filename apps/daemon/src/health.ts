import { createServer, type Server } from "node:http";
import type { Logger } from "@surf/core";

export interface HealthProvider {
  (): { ok: boolean; details: Record<string, unknown> };
}

/** Minimal health endpoint for Docker HEALTHCHECK and the ops workflow. Loopback only. */
export function startHealthServer(port: number, provider: HealthProvider, log: Logger): Server {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      const h = provider();
      res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: h.ok, ...h.details }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, "127.0.0.1", () => log.info({ port }, "health server listening"));
  return server;
}
