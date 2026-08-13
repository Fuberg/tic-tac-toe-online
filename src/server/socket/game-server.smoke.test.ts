import { createServer, type Server as HttpServer } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { attachGameServer } from "./game-server";

// Thin-adapter smoke coverage only (per the issue's testing decisions) — the reducer this
// wraps already has the real test investment in ../domain/*.test.ts.
describe("game-server — socket.io smoke test", () => {
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let url: string;

  beforeEach(async () => {
    httpServer = createServer();
    io = new SocketIOServer(httpServer);
    attachGameServer(io, { botMoveDelayMs: 0 });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    url = `http://localhost:${port}`;
  });

  afterEach(async () => {
    io.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  function connect(): Promise<ClientSocket> {
    return new Promise((resolve) => {
      const socket = ioClient(url, { transports: ["websocket"] });
      socket.on("connect", () => resolve(socket));
    });
  }

  it("joins the lobby and receives itself in a lobby:update broadcast", async () => {
    const socket = await connect();
    try {
      const updatePromise = new Promise<{ players: { id: string; nickname: string }[] }>((resolve) =>
        socket.once("lobby:update", resolve),
      );
      const ack = await new Promise((resolve) => socket.emit("lobby:join", { nickname: "Alice" }, resolve));
      expect(ack).toEqual({ ok: true });

      const update = await updatePromise;
      expect(update.players.map((p) => p.nickname)).toContain("Alice");
    } finally {
      socket.disconnect();
    }
  });

  it("starts a bot match and both sides can play a full game to completion", async () => {
    const socket = await connect();
    try {
      await new Promise((resolve) => socket.emit("lobby:join", { nickname: "Bob" }, resolve));

      // One persistent listener, registered before the match even starts, drives the whole
      // game — placing whenever it's our human turn (seatA, by START_BOT_MATCH's design) and
      // letting the server's own bot-move scheduling handle the bot's replies. Every emit
      // passes an ack callback deliberately, matching how a real client should behave (it
      // needs to know if its move was rejected) — omitting it here was flaky in practice.
      const finished = await new Promise<{ match: { status: string } }>((resolve) => {
        socket.on("match:update", (snapshot) => {
          if (!snapshot) return;
          if (snapshot.match.status !== "in-progress") {
            resolve(snapshot);
            return;
          }
          const humanMark = snapshot.match.seatA;
          if (snapshot.match.currentPlayer !== humanMark) return; // waiting on the bot
          const cell = snapshot.match.board.findIndex((c: unknown) => c == null);
          socket.emit("match:place", { matchId: snapshot.id, cell }, () => {});
        });
        socket.emit("bot:start", { difficulty: "easy" }, () => {});
      });

      expect(["won", "forfeited"]).toContain(finished.match.status);
    } finally {
      socket.disconnect();
    }
  }, 10_000);
});
