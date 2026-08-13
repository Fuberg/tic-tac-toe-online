import { createServer, type Server as HttpServer } from "node:http";
import { type AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import { attachGameServer } from "./game-server";

// Joins two sockets as "Alice"/"Bob", has Alice challenge Bob, and has Bob accept — returning
// the started match snapshot. Shared by both describe blocks below (mutual-rematch/leave and
// match-timeout-forfeit), which each need a two-human match but diverge after it starts.
async function challengeIntoMatch(alice: ClientSocket, bob: ClientSocket) {
  const bobKnownToAlice = new Promise<string>((resolve) => {
    alice.on("lobby:update", (snapshot) => {
      const bobEntry = snapshot.players.find((p: { nickname: string }) => p.nickname === "Bob");
      if (bobEntry) resolve(bobEntry.id);
    });
  });
  const bobPending = new Promise<{ id: string }>((resolve) => bob.once("challenge:pending", resolve));

  await Promise.all([
    new Promise((resolve) => alice.emit("lobby:join", { nickname: "Alice" }, resolve)),
    new Promise((resolve) => bob.emit("lobby:join", { nickname: "Bob" }, resolve)),
  ]);
  const bobId = await bobKnownToAlice;
  await new Promise((resolve) => alice.emit("challenge:send", { toPlayerId: bobId }, resolve));
  const pending = await bobPending;

  return new Promise<{ id: string; match: { seatA: string } }>((resolve) => {
    alice.once("match:update", resolve);
    bob.emit("challenge:accept", { challengeId: pending.id }, () => {});
  });
}

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

  // Regression test: every handler must dispatch() unconditionally even when a caller omits
  // the ack callback (a valid, intentional style — match.tsx's cell clicks used to be
  // fire-and-forget like this, which is exactly how this bug was found). The tempting inline
  // shape `ack?.(ackFromEvents(dispatch(...)))` looks equivalent but isn't: optional-call
  // syntax skips evaluating its arguments too, so when `ack` is undefined that form never
  // calls dispatch() and silently drops the action — this test fails loudly if that regresses.
  it("applies a placed mark even when the client emits match:place with no ack callback", async () => {
    const socket = await connect();
    try {
      await new Promise((resolve) => socket.emit("lobby:join", { nickname: "Eve" }, resolve));
      const started = await new Promise<{
        id: string;
        match: { seatA: string; currentPlayer: string; board: unknown[] };
      }>((resolve) => {
        socket.once("match:update", resolve);
        socket.emit("bot:start", { difficulty: "easy" }, () => {});
      });

      const humanMark = started.match.seatA;
      const myTurnSnapshot =
        started.match.currentPlayer === humanMark
          ? started
          : await new Promise<{ id: string; match: { currentPlayer: string; board: unknown[] } }>((resolve) => {
              socket.on("match:update", function onUpdate(snapshot) {
                if (snapshot?.match.currentPlayer === humanMark) {
                  socket.off("match:update", onUpdate);
                  resolve(snapshot);
                }
              });
            });

      const cell = myTurnSnapshot.match.board.findIndex((c) => c == null);
      const nextUpdate = new Promise<{ match: { board: unknown[] } }>((resolve) =>
        socket.once("match:update", resolve),
      );
      socket.emit("match:place", { matchId: myTurnSnapshot.id, cell }); // no ack — see comment above

      const updated = await nextUpdate;
      expect(updated.match.board[cell]).toBe(humanMark);
    } finally {
      socket.disconnect();
    }
  }, 10_000);

  // Issue #5: a bot opponent's rematch agreement is instant — the human's single
  // match:requestRematch must produce an in-progress rematch straight away, not a wait.
  it("instantly starts a rematch with swapped sides when the opponent is a bot", async () => {
    const socket = await connect();
    try {
      await new Promise((resolve) => socket.emit("lobby:join", { nickname: "Carol" }, resolve));

      function driveBotGame(): Promise<{ id: string; match: { status: string; seatA: string } }> {
        return new Promise((resolve) => {
          function onUpdate(snapshot: { id: string; match: { status: string; seatA: string; currentPlayer: string; board: unknown[] } } | null) {
            if (!snapshot) return;
            if (snapshot.match.status !== "in-progress") {
              socket.off("match:update", onUpdate);
              resolve(snapshot);
              return;
            }
            const humanMark = snapshot.match.seatA;
            if (snapshot.match.currentPlayer !== humanMark) return; // waiting on the bot
            const cell = snapshot.match.board.findIndex((c) => c == null);
            socket.emit("match:place", { matchId: snapshot.id, cell }, () => {});
          }
          socket.on("match:update", onUpdate);
        });
      }

      socket.emit("bot:start", { difficulty: "easy" }, () => {});
      const finished = await driveBotGame();
      expect(finished.match.status).toBe("won");
      const humanMarkBefore = finished.match.seatA;

      const rematched = await new Promise<{ match: { status: string; seatA: string } }>((resolve) => {
        socket.once("match:update", resolve);
        socket.emit("match:requestRematch", { matchId: finished.id }, () => {});
      });
      expect(rematched.match.status).toBe("in-progress");
      expect(rematched.match.seatA).toBe(humanMarkBefore === "X" ? "O" : "X");
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

  // Plays a fixed sequence on top of challengeIntoMatch that always wins for whichever side
  // holds "X" (top row: X,O,X,O,X) — mirrors the domain test's xWinningMoves, but sides are
  // resolved at runtime since seat-to-mark assignment is random.
  async function startTwoHumanMatchAndWin(alice: ClientSocket, bob: ClientSocket) {
    const started = await challengeIntoMatch(alice, bob);

    // entry.seatA is always the challenger (Alice); its mark tells us who moves first.
    const [xSocket, oSocket] = started.match.seatA === "X" ? [alice, bob] : [bob, alice];
    const finalUpdate = new Promise<{ match: { status: string } }>((resolve) => {
      function onUpdate(snapshot: { match: { status: string } } | null) {
        if (snapshot && snapshot.match.status !== "in-progress") {
          alice.off("match:update", onUpdate);
          resolve(snapshot);
        }
      }
      alice.on("match:update", onUpdate);
    });
    for (const [index, cell] of [0, 3, 1, 4, 2].entries()) {
      const mover = index % 2 === 0 ? xSocket : oSocket;
      await new Promise((resolve) => mover.emit("match:place", { matchId: started.id, cell }, resolve));
    }
    const finished = await finalUpdate;
    expect(finished.match.status).toBe("won");
    return started.id;
  }

  it("lets two human players agree to a rematch, which swaps sides", async () => {
    const alice = await connect();
    const bob = await connect();
    try {
      const matchId = await startTwoHumanMatchAndWin(alice, bob);

      // Wait for BOTH sockets to receive the "waiting" broadcast before moving on — otherwise
      // Bob's next listener (registered right after) can race ahead of his own copy of this
      // same broadcast still in flight, and swallow it instead of his rematch's update.
      const bothSeeWaiting = Promise.all([
        new Promise<{ match: { status: string }; rematchRequestedBy: string | null }>((resolve) =>
          alice.once("match:update", resolve),
        ),
        new Promise((resolve) => bob.once("match:update", resolve)),
      ]);
      alice.emit("match:requestRematch", { matchId }, () => {});
      const [waiting] = await bothSeeWaiting;
      expect(waiting.match.status).toBe("won"); // unchanged, still waiting on Bob
      expect(waiting.rematchRequestedBy).not.toBeNull();

      // Filters rather than a plain .once: a fresh listener registered right after Bob's own
      // "waiting" broadcast can otherwise still race that very packet on the wire and consume
      // it instead of the actual post-rematch update.
      const rematched = await new Promise<{ match: { status: string } }>((resolve) => {
        function onUpdate(snapshot: { match: { status: string } } | null) {
          if (snapshot && snapshot.match.status === "in-progress") {
            bob.off("match:update", onUpdate);
            resolve(snapshot);
          }
        }
        bob.on("match:update", onUpdate);
        bob.emit("match:requestRematch", { matchId }, () => {});
      });
      expect(rematched.match.status).toBe("in-progress");
    } finally {
      alice.disconnect();
      bob.disconnect();
    }
  }, 10_000);

  // CONTEXT.md Rematch section: leaving instead of accepting a pending rematch request sends
  // both players (including the one still waiting) back to the lobby, over the real transport.
  it("sends both players back to the lobby if one leaves instead of accepting a pending rematch", async () => {
    const alice = await connect();
    const bob = await connect();
    try {
      const matchId = await startTwoHumanMatchAndWin(alice, bob);

      const bothSeeWaiting = Promise.all([
        new Promise((resolve) => alice.once("match:update", resolve)),
        new Promise((resolve) => bob.once("match:update", resolve)),
      ]);
      alice.emit("match:requestRematch", { matchId }, () => {});
      await bothSeeWaiting;

      function waitForNull(socket: ClientSocket) {
        return new Promise<unknown>((resolve) => {
          function onUpdate(snapshot: unknown) {
            if (snapshot === null) {
              socket.off("match:update", onUpdate);
              resolve(snapshot);
            }
          }
          socket.on("match:update", onUpdate);
        });
      }

      const [aliceEnded, bobEnded] = await Promise.all([
        waitForNull(alice),
        waitForNull(bob),
        new Promise((resolve) => bob.emit("match:leave", { matchId }, resolve)),
      ]);
      expect(aliceEnded).toBeNull();
      expect(bobEnded).toBeNull();
    } finally {
      alice.disconnect();
      bob.disconnect();
    }
  }, 10_000);

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

// Issue #5: a player disconnecting mid-Match forfeits it to the opponent once the
// match-timeout elapses. A separate server instance with a short matchTimeoutMs keeps this
// from waiting on the real 10s default.
describe("game-server — match-timeout forfeit on disconnect", () => {
  let httpServer: HttpServer;
  let io: SocketIOServer;
  let url: string;
  const TEST_MATCH_TIMEOUT_MS = 30;

  beforeEach(async () => {
    httpServer = createServer();
    io = new SocketIOServer(httpServer);
    attachGameServer(io, { botMoveDelayMs: 0, matchTimeoutMs: TEST_MATCH_TIMEOUT_MS });
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

  it("forfeits the match to the opponent once the disconnecting player's match-timeout elapses", async () => {
    const alice = await connect();
    const bob = await connect();
    try {
      await challengeIntoMatch(alice, bob);

      const bobSeesForfeit = new Promise<{ match: { status: string; winner: string; seatB: string } }>((resolve) => {
        bob.on("match:update", (snapshot) => {
          if (snapshot?.match.status === "forfeited") resolve(snapshot);
        });
      });

      alice.disconnect(); // Alice is the challenger (seatA) — her disconnect should forfeit to Bob (seatB).
      const finalSnapshot = await bobSeesForfeit;
      expect(finalSnapshot.match.status).toBe("forfeited");
      expect(finalSnapshot.match.winner).toBe(finalSnapshot.match.seatB);
    } finally {
      bob.disconnect();
    }
  }, 10_000);

  // Issue #13: previously Alice's lobby entry lingered forever, only ever cleared as a side
  // effect of Bob explicitly leaving the finished match — and even then it flipped to
  // "available" rather than disappearing. Bob here never sends match:leave.
  it("removes the disconnected player's lobby entry once their match resolves via forfeit, without the opponent taking any action", async () => {
    const alice = await connect();
    const bob = await connect();
    try {
      await challengeIntoMatch(alice, bob);

      const aliceGoneFromLobby = new Promise<{ players: { nickname: string }[] }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for lobby:update")), 5_000);
        bob.on("lobby:update", (snapshot) => {
          if (!snapshot.players.some((p: { nickname: string }) => p.nickname === "Alice")) {
            clearTimeout(timer);
            resolve(snapshot);
          }
        });
      });

      alice.disconnect();
      const snapshot = await aliceGoneFromLobby;
      expect(snapshot.players.some((p) => p.nickname === "Alice")).toBe(false);
      expect(snapshot.players.some((p) => p.nickname === "Bob")).toBe(true);
    } finally {
      bob.disconnect();
    }
  }, 10_000);
});
