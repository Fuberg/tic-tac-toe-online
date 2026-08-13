// Custom server (docs/adr/0001-self-hosted-deployment.md): lobby/challenge/match state is
// server-authoritative and lives in one long-lived Node process's memory, which Socket.IO
// needs and Next's default serverless-friendly server doesn't provide.
import { createServer } from "node:http";
import next from "next";
import { Server as SocketIOServer } from "socket.io";
import { MATCH_TIMEOUT_MS } from "./src/server/domain/lobby";
import { attachGameServer } from "./src/server/socket/game-server";

const port = parseInt(process.env.PORT || "3000", 10);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => handle(req, res));

  const io = new SocketIOServer(httpServer, {
    // Lets a briefly-dropped connection (e.g. a network blip) resume with the same socket.id
    // and room memberships, which is what makes the 10s match-timeout meaningful — see
    // Implementation Decisions in issue #1.
    connectionStateRecovery: { maxDisconnectionDuration: MATCH_TIMEOUT_MS },
  });
  const gameServer = attachGameServer(io);

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    gameServer.shutdown();
    // Give the shutdown broadcast a moment to flush to clients before closing.
    setTimeout(() => {
      httpServer.close(() => process.exit(0));
    }, 500).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  httpServer.listen(port, () => {
    console.log(`> Ready on http://localhost:${port} (${dev ? "development" : process.env.NODE_ENV})`);
  });
});
