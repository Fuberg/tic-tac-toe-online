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

  // Passed as attachGameServer's lobbyTimeoutMs so the lobby-timeout tests below don't wait
  // on the real 5s default.
  const TEST_LOBBY_TIMEOUT_MS = 20;

  beforeEach(async () => {
    httpServer = createServer();
    io = new SocketIOServer(httpServer);
    attachGameServer(io, { botMoveDelayMs: 0, lobbyTimeoutMs: TEST_LOBBY_TIMEOUT_MS });
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

  it("delivers a challenge to its target and starts a match once accepted", async () => {
    const alice = await connect();
    const bob = await connect();
    try {
      // Registered before either join, so the broadcast that first includes both players
      // can't arrive in the gap before a listener exists (see the bot-match test's comment).
      const bobKnownToAlice = new Promise<string>((resolve) => {
        alice.on("lobby:update", (snapshot) => {
          const bobEntry = snapshot.players.find((p: { nickname: string }) => p.nickname === "Bob");
          if (bobEntry) resolve(bobEntry.id);
        });
      });
      const bobPending = new Promise<{ id: string; fromPlayerId: string }>((resolve) =>
        bob.once("challenge:pending", resolve),
      );

      const [aliceAck, bobAck] = await Promise.all([
        new Promise((resolve) => alice.emit("lobby:join", { nickname: "Alice" }, resolve)),
        new Promise((resolve) => bob.emit("lobby:join", { nickname: "Bob" }, resolve)),
      ]);
      expect(aliceAck).toEqual({ ok: true });
      expect(bobAck).toEqual({ ok: true });

      const bobId = await bobKnownToAlice;
      const sendAck = await new Promise((resolve) =>
        alice.emit("challenge:send", { toPlayerId: bobId }, resolve),
      );
      expect(sendAck).toEqual({ ok: true });
      const pending = await bobPending;
      expect(pending.fromPlayerId).not.toBe(bobId);

      const aliceMatchPromise = new Promise((resolve) => alice.once("match:update", resolve));
      const bobMatchPromise = new Promise((resolve) => bob.once("match:update", resolve));
      const acceptAck = await new Promise((resolve) =>
        bob.emit("challenge:accept", { challengeId: pending.id }, resolve),
      );
      expect(acceptAck).toEqual({ ok: true });

      const [aliceMatch, bobMatch] = await Promise.all([aliceMatchPromise, bobMatchPromise]);
      expect(aliceMatch).toEqual(bobMatch);
    } finally {
      alice.disconnect();
      bob.disconnect();
    }
  });

  it("removes a player from the lobby after the lobby-timeout elapses while their tab is hidden", async () => {
    const alice = await connect();
    const bob = await connect();
    try {
      await new Promise((resolve) => alice.emit("lobby:join", { nickname: "Alice" }, resolve));
      await new Promise((resolve) => bob.emit("lobby:join", { nickname: "Bob" }, resolve));

      const aliceLeft = new Promise<void>((resolve) => {
        bob.on("lobby:update", (snapshot) => {
          if (!snapshot.players.some((p: { nickname: string }) => p.nickname === "Alice")) resolve();
        });
      });
      alice.emit("lobby:visibility", { hidden: true });

      await aliceLeft;
    } finally {
      alice.disconnect();
      bob.disconnect();
    }
  });

  it("does not remove a player if their tab becomes visible again before the lobby-timeout", async () => {
    const alice = await connect();
    const bob = await connect();
    try {
      await new Promise((resolve) => alice.emit("lobby:join", { nickname: "Alice" }, resolve));
      await new Promise((resolve) => bob.emit("lobby:join", { nickname: "Bob" }, resolve));

      alice.emit("lobby:visibility", { hidden: true });
      alice.emit("lobby:visibility", { hidden: false });

      // Outlast the lobby-timeout window with no removal event arriving.
      const removed = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), TEST_LOBBY_TIMEOUT_MS * 3);
        bob.on("lobby:update", (snapshot) => {
          if (!snapshot.players.some((p: { nickname: string }) => p.nickname === "Alice")) {
            clearTimeout(timer);
            resolve(true);
          }
        });
      });

      expect(await removed).toBe(false);
    } finally {
      alice.disconnect();
      bob.disconnect();
    }
  });
});
