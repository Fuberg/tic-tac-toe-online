import { describe, expect, it } from "vitest";
import {
  CHALLENGE_DEADLINE_MS,
  createEmptyLobbyState,
  handleAction,
  playerStatus,
} from "./lobby";
import type { LobbyEvent, LobbyState } from "./lobby.types";

const NOW = 1_000_000;
const rngAlwaysA = () => 0; // seatA gets "X"
const rngAlwaysB = () => 0.99; // seatA gets "O"

function join(state: LobbyState, playerId: string, nickname: string) {
  return handleAction(state, { type: "JOIN_LOBBY", playerId, nickname }, NOW);
}

describe("lobby — joining and leaving", () => {
  it("adds a player on join and removes them on leave", () => {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));
    expect(playerStatus(state, "p1")).toBe("available");

    const { state: after, events } = handleAction(state, { type: "LEAVE_LOBBY", playerId: "p1" }, NOW);
    expect(playerStatus(after, "p1")).toBeNull();
    expect(events).toEqual([{ type: "PLAYER_LEFT", playerId: "p1" }]);
  });

  it("rejects leaving the lobby while in an active match", () => {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));
    ({ state } = handleAction(
      state,
      { type: "START_BOT_MATCH", matchId: "m1", playerId: "p1", difficulty: "easy" },
      NOW,
      rngAlwaysA,
    ));

    const { events } = handleAction(state, { type: "LEAVE_LOBBY", playerId: "p1" }, NOW);
    expect(events).toEqual([{ type: "ACTION_REJECTED", reason: "in-match" }]);
  });
});

describe("lobby — challenges", () => {
  function twoPlayers() {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));
    ({ state } = join(state, "p2", "Bob"));
    return state;
  }

  it("creates a pending challenge with a shared deadline and marks both players busy", () => {
    const state = twoPlayers();
    const { state: after, events } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    );

    expect(playerStatus(after, "p1")).toBe("busy");
    expect(playerStatus(after, "p2")).toBe("busy");
    expect(events).toEqual([
      {
        type: "CHALLENGE_CREATED",
        challenge: { id: "c1", fromPlayerId: "p1", toPlayerId: "p2", deadline: NOW + CHALLENGE_DEADLINE_MS },
      },
    ]);
  });

  it("blocks sending or receiving a second challenge while busy", () => {
    let state = twoPlayers();
    ({ state } = join(state, "p3", "Carol"));
    ({ state } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    ));

    const { events: senderBusy } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c2", fromPlayerId: "p1", toPlayerId: "p3" },
      NOW,
    );
    expect(senderBusy).toEqual([
      { type: "CHALLENGE_REJECTED", fromPlayerId: "p1", toPlayerId: "p3", reason: "sender-unavailable" },
    ]);

    const { events: targetBusy } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c3", fromPlayerId: "p3", toPlayerId: "p2" },
      NOW,
    );
    expect(targetBusy).toEqual([
      { type: "CHALLENGE_REJECTED", fromPlayerId: "p3", toPlayerId: "p2", reason: "target-unavailable" },
    ]);
  });

  it("accepting a challenge starts a match and clears busy status via in-game", () => {
    let state = twoPlayers();
    ({ state } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    ));

    const { state: after, events } = handleAction(
      state,
      { type: "ACCEPT_CHALLENGE", challengeId: "c1", matchId: "m1", playerId: "p2" },
      NOW,
      rngAlwaysA,
    );

    expect(playerStatus(after, "p1")).toBe("in-game");
    expect(playerStatus(after, "p2")).toBe("in-game");
    expect(after.matches.m1.match.status).toBe("in-progress");
    const startedEvent = events.find((e): e is Extract<LobbyEvent, { type: "MATCH_STARTED" }> =>
      e.type === "MATCH_STARTED",
    );
    expect(startedEvent).toBeDefined();
    expect(startedEvent!.seatA).toEqual({ type: "player", playerId: "p1" });
    expect(startedEvent!.seatB).toEqual({ type: "player", playerId: "p2" });
  });

  // Server-authoritative per the Solution section: only the invited player can act on a
  // challenge that was sent to them — not the sender, not a bystander.
  it("rejects accept/decline from anyone other than the challenge's target", () => {
    let state = twoPlayers();
    ({ state } = join(state, "p3", "Carol"));
    ({ state } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    ));

    const { events: senderAccepts } = handleAction(
      state,
      { type: "ACCEPT_CHALLENGE", challengeId: "c1", matchId: "m1", playerId: "p1" },
      NOW,
    );
    expect(senderAccepts).toEqual([{ type: "ACTION_REJECTED", reason: "not-the-target" }]);

    const { events: bystanderDeclines } = handleAction(
      state,
      { type: "DECLINE_CHALLENGE", challengeId: "c1", playerId: "p3" },
      NOW,
    );
    expect(bystanderDeclines).toEqual([{ type: "ACTION_REJECTED", reason: "not-the-target" }]);
  });

  it("expires a pending challenge on CHALLENGE_TIMEOUT and frees both players", () => {
    let state = twoPlayers();
    ({ state } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    ));

    const challenge = { id: "c1", fromPlayerId: "p1", toPlayerId: "p2", deadline: NOW + CHALLENGE_DEADLINE_MS };
    const { state: after, events } = handleAction(state, { type: "CHALLENGE_TIMEOUT", challengeId: "c1" }, NOW);
    expect(events).toEqual([{ type: "CHALLENGE_EXPIRED", challenge }]);
    expect(playerStatus(after, "p1")).toBe("available");
    expect(playerStatus(after, "p2")).toBe("available");
  });

  // CONTEXT.md distinguishes this from an explicit decline: "Если challenger покидает лобби
  // ... до ответа — Challenge исчезает вместе с ним."
  it("cancels (not declines) a pending challenge when a party leaves the lobby", () => {
    let state = twoPlayers();
    ({ state } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    ));

    const challenge = { id: "c1", fromPlayerId: "p1", toPlayerId: "p2", deadline: NOW + CHALLENGE_DEADLINE_MS };
    const { state: after, events } = handleAction(state, { type: "LEAVE_LOBBY", playerId: "p1" }, NOW);
    expect(events).toEqual([
      { type: "CHALLENGE_CANCELLED", challenge, reason: "challenger-left" },
      { type: "PLAYER_LEFT", playerId: "p1" },
    ]);
    expect(playerStatus(after, "p2")).toBe("available");
  });
});

describe("lobby — bot match", () => {
  it("starts an instant match against a bot with no challenge step", () => {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));

    const { state: after, events } = handleAction(
      state,
      { type: "START_BOT_MATCH", matchId: "m1", playerId: "p1", difficulty: "hard" },
      NOW,
      rngAlwaysB,
    );

    expect(Object.keys(after.challenges)).toEqual([]);
    expect(after.matches.m1.seatB).toEqual({ type: "bot", difficulty: "hard" });
    expect(playerStatus(after, "p1")).toBe("in-game");
    expect(events.some((e) => e.type === "MATCH_STARTED")).toBe(true);
  });

  it("plays out a full bot match end to end via PLACE and REQUEST_BOT_MOVE", () => {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));
    // Force player p1 onto seatA as "X" so it always moves first and we drive the whole game.
    ({ state } = handleAction(
      state,
      { type: "START_BOT_MATCH", matchId: "m1", playerId: "p1", difficulty: "easy" },
      NOW,
      rngAlwaysA,
    ));
    expect(state.matches.m1.match.seatA).toBe("X");

    let guard = 0;
    while (state.matches.m1.match.status === "in-progress" && guard++ < 30) {
      const mover = state.matches.m1.match.currentPlayer;
      if (mover === "X") {
        const board = state.matches.m1.match.board;
        const cell = board.findIndex((c) => c == null);
        ({ state } = handleAction(state, { type: "PLACE", matchId: "m1", playerId: "p1", cell: cell as never }, NOW));
      } else {
        ({ state } = handleAction(state, { type: "REQUEST_BOT_MOVE", matchId: "m1" }, NOW, () => 0.42));
      }
    }

    expect(state.matches.m1.match.status).not.toBe("in-progress");
  });

  it("rejects a PLACE from a player who isn't in the match, and out-of-turn moves", () => {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));
    ({ state } = join(state, "intruder", "Mallory"));
    ({ state } = handleAction(
      state,
      { type: "START_BOT_MATCH", matchId: "m1", playerId: "p1", difficulty: "easy" },
      NOW,
      rngAlwaysB, // seatA (p1) gets "O", so bot (seatB, "X") moves first
    ));

    const { events: intruderEvents } = handleAction(
      state,
      { type: "PLACE", matchId: "m1", playerId: "intruder", cell: 0 },
      NOW,
    );
    expect(intruderEvents).toEqual([{ type: "ACTION_REJECTED", reason: "not-a-participant" }]);

    const { events: outOfTurnEvents } = handleAction(
      state,
      { type: "PLACE", matchId: "m1", playerId: "p1", cell: 0 },
      NOW,
    );
    expect(outOfTurnEvents).toEqual([{ type: "ACTION_REJECTED", reason: "not-your-turn" }]);
  });
});

describe("lobby — forfeit, rematch, and leaving the result screen", () => {
  function startHumanMatch(rng: () => number) {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));
    ({ state } = join(state, "p2", "Bob"));
    ({ state } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    ));
    ({ state } = handleAction(
      state,
      { type: "ACCEPT_CHALLENGE", challengeId: "c1", matchId: "m1", playerId: "p2" },
      NOW,
      rng,
    ));
    return state;
  }

  it("forfeiting ends the match, and rematch is unavailable afterward", () => {
    const state = startHumanMatch(rngAlwaysA);

    const { state: forfeited, events } = handleAction(state, { type: "FORFEIT", matchId: "m1", playerId: "p1" }, NOW);
    expect(forfeited.matches.m1.match.status).toBe("forfeited");
    expect(events.some((e) => e.type === "MATCH_FORFEITED")).toBe(true);
    // both players remain "in-game" (on the result screen) until they explicitly leave
    expect(playerStatus(forfeited, "p1")).toBe("in-game");
    expect(playerStatus(forfeited, "p2")).toBe("in-game");

    const { events: rematchEvents } = handleAction(
      forfeited,
      { type: "REQUEST_REMATCH", matchId: "m1", playerId: "p2" },
      NOW,
    );
    expect(rematchEvents).toEqual([{ type: "ACTION_REJECTED", reason: "forfeited-match" }]);
  });

  it("leaving from the result screen returns both players to the lobby, even mid-rematch-request", () => {
    let state = startHumanMatch(rngAlwaysA);
    ({ state } = handleAction(state, { type: "FORFEIT", matchId: "m1", playerId: "p1" }, NOW));

    const { state: after, events } = handleAction(state, { type: "LEAVE_MATCH", matchId: "m1", playerId: "p2" }, NOW);
    expect(events).toEqual([{ type: "MATCH_ENDED", matchId: "m1" }]);
    expect(after.matches.m1).toBeUndefined();
    expect(playerStatus(after, "p1")).toBe("available");
    expect(playerStatus(after, "p2")).toBe("available");
  });

  it("rematch requires both players to agree, then swaps seats", () => {
    // Play a quick win for whoever is X so status becomes "won" (rematch only follows a win).
    let state = startHumanMatch(rngAlwaysA); // p1=seatA="X", p2=seatB="O"
    const xWinningMoves = [0, 3, 1, 4, 2]; // X:0,1,2 (top row) around O:3,4
    for (let i = 0; i < xWinningMoves.length; i++) {
      const playerId = i % 2 === 0 ? "p1" : "p2";
      ({ state } = handleAction(state, { type: "PLACE", matchId: "m1", playerId, cell: xWinningMoves[i] as never }, NOW));
    }
    expect(state.matches.m1.match.status).toBe("won");
    expect(state.matches.m1.match.winner).toBe("X");

    const { state: afterFirstRequest, events: firstEvents } = handleAction(
      state,
      { type: "REQUEST_REMATCH", matchId: "m1", playerId: "p1" },
      NOW,
    );
    expect(firstEvents).toEqual([{ type: "REMATCH_REQUESTED", matchId: "m1", bySeat: "seatA" }]);
    expect(afterFirstRequest.matches.m1.match.status).toBe("won"); // unchanged, still waiting

    const { state: afterSecondRequest, events: secondEvents } = handleAction(
      afterFirstRequest,
      { type: "REQUEST_REMATCH", matchId: "m1", playerId: "p2" },
      NOW,
    );
    expect(secondEvents.some((e) => e.type === "MATCH_STARTED")).toBe(true);
    const rematchedMatch = afterSecondRequest.matches.m1.match;
    expect(rematchedMatch.status).toBe("in-progress");
    expect(rematchedMatch.seatA).toBe("O"); // seats swapped: p1 was X, now O
    expect(rematchedMatch.seatB).toBe("X");
    // participant identity (who sits in seatA/seatB) is unchanged — only the marks swapped
    expect(afterSecondRequest.matches.m1.seatA).toEqual({ type: "player", playerId: "p1" });
  });

  // Issue #5: "для бота согласие происходит мгновенно" — a bot never sends its own
  // REQUEST_REMATCH, so the rematch must complete on the human's single request.
  it("a bot opponent agrees to a rematch instantly, with no REMATCH_REQUESTED wait", () => {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));
    ({ state } = handleAction(
      state,
      { type: "START_BOT_MATCH", matchId: "m1", playerId: "p1", difficulty: "easy" },
      NOW,
      rngAlwaysA, // p1 = seatA = "X", moves first
    ));

    let guard = 0;
    while (state.matches.m1.match.status === "in-progress" && guard++ < 30) {
      if (state.matches.m1.match.currentPlayer === "X") {
        const board = state.matches.m1.match.board;
        const cell = board.findIndex((c) => c == null);
        ({ state } = handleAction(state, { type: "PLACE", matchId: "m1", playerId: "p1", cell: cell as never }, NOW));
      } else {
        ({ state } = handleAction(state, { type: "REQUEST_BOT_MOVE", matchId: "m1" }, NOW, () => 0.42));
      }
    }
    expect(state.matches.m1.match.status).toBe("won");
    const seatABefore = state.matches.m1.match.seatA;

    const { state: after, events } = handleAction(
      state,
      { type: "REQUEST_REMATCH", matchId: "m1", playerId: "p1" },
      NOW,
    );

    expect(events.some((e) => e.type === "REMATCH_REQUESTED")).toBe(false);
    expect(events.some((e) => e.type === "MATCH_STARTED")).toBe(true);
    expect(after.matches.m1.rematchRequestedBy).toBeNull();
    expect(after.matches.m1.match.status).toBe("in-progress");
    expect(after.matches.m1.match.seatA).toBe(seatABefore === "X" ? "O" : "X");
  });

  // CONTEXT.md Rematch section: "Если партнёр вместо реванша нажимает «Выйти в лобби» —
  // обоих (включая ожидавшего) возвращает в лобби, реванш не создаётся."
  it("if one player leaves instead of accepting a pending rematch request, both return to lobby", () => {
    let state = startHumanMatch(rngAlwaysA);
    const xWinningMoves = [0, 3, 1, 4, 2];
    for (let i = 0; i < xWinningMoves.length; i++) {
      const playerId = i % 2 === 0 ? "p1" : "p2";
      ({ state } = handleAction(state, { type: "PLACE", matchId: "m1", playerId, cell: xWinningMoves[i] as never }, NOW));
    }
    ({ state } = handleAction(state, { type: "REQUEST_REMATCH", matchId: "m1", playerId: "p1" }, NOW));
    expect(state.matches.m1.rematchRequestedBy).toBe("seatA");

    const { state: after, events } = handleAction(state, { type: "LEAVE_MATCH", matchId: "m1", playerId: "p2" }, NOW);
    expect(events).toEqual([{ type: "MATCH_ENDED", matchId: "m1" }]);
    expect(after.matches.m1).toBeUndefined();
    expect(playerStatus(after, "p1")).toBe("available");
    expect(playerStatus(after, "p2")).toBe("available");
  });
});

// Issue #13: a player who disconnects mid-match used to linger in the lobby roster forever —
// their matchOfPlayer entry only got cleared as a side effect of the opponent explicitly
// leaving the finished match, at which point they'd show as "available" despite nobody being
// connected as them.
describe("lobby — disconnecting", () => {
  function startHumanMatch(rng: () => number) {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));
    ({ state } = join(state, "p2", "Bob"));
    ({ state } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    ));
    ({ state } = handleAction(
      state,
      { type: "ACCEPT_CHALLENGE", challengeId: "c1", matchId: "m1", playerId: "p2" },
      NOW,
      rng,
    ));
    return state;
  }

  it("removes a player from the lobby immediately when they disconnect while not in a match (regression guard)", () => {
    let state = createEmptyLobbyState();
    ({ state } = join(state, "p1", "Alice"));

    const { state: after, events } = handleAction(state, { type: "DISCONNECT", playerId: "p1" }, NOW);
    expect(playerStatus(after, "p1")).toBeNull();
    expect(events).toEqual([{ type: "PLAYER_LEFT", playerId: "p1" }]);
  });

  it("fully removes a player who disconnected mid-match once their match resolves via forfeit — regardless of the opponent's actions", () => {
    const state = startHumanMatch(rngAlwaysA);

    const { state: disconnected, events: disconnectEvents } = handleAction(
      state,
      { type: "DISCONNECT", playerId: "p1" },
      NOW,
    );
    // No immediate removal — leaving mid-match is rejected by design, so this is deferred.
    expect(disconnectEvents).toEqual([]);
    expect(playerStatus(disconnected, "p1")).toBe("in-game");

    // Match-timeout forfeit fires (existing mechanism, unchanged) — opponent p2 takes no action.
    const { state: forfeited, events } = handleAction(
      disconnected,
      { type: "FORFEIT", matchId: "m1", playerId: "p1" },
      NOW,
    );
    expect(forfeited.matches.m1.match.status).toBe("forfeited");
    expect(playerStatus(forfeited, "p1")).toBeNull(); // gone — not "available"
    expect(forfeited.players.p1).toBeUndefined();
    expect(events.some((e) => e.type === "PLAYER_LEFT" && e.playerId === "p1")).toBe(true);
    // Opponent is unaffected and didn't need to do anything.
    expect(playerStatus(forfeited, "p2")).toBe("in-game");
  });

  it("removes a disconnected player once their match resolves via a normal win too, not just forfeit", () => {
    let state = startHumanMatch(rngAlwaysA); // p1=seatA="X", p2=seatB="O"
    ({ state } = handleAction(state, { type: "DISCONNECT", playerId: "p2" }, NOW));

    const xWinningMoves = [0, 3, 1, 4, 2];
    for (let i = 0; i < xWinningMoves.length; i++) {
      const playerId = i % 2 === 0 ? "p1" : "p2";
      ({ state } = handleAction(state, { type: "PLACE", matchId: "m1", playerId, cell: xWinningMoves[i] as never }, NOW));
    }

    expect(state.matches.m1.match.status).toBe("won");
    expect(playerStatus(state, "p2")).toBeNull();
    expect(playerStatus(state, "p1")).toBe("in-game");
  });

  it("cancels the deferred removal if the disconnected player reconnects before the match resolves", () => {
    let state = startHumanMatch(rngAlwaysA);
    ({ state } = handleAction(state, { type: "DISCONNECT", playerId: "p1" }, NOW));
    ({ state } = handleAction(state, { type: "RECONNECTED", playerId: "p1" }, NOW));

    const { state: forfeited } = handleAction(state, { type: "FORFEIT", matchId: "m1", playerId: "p2" }, NOW);
    expect(forfeited.matches.m1.match.status).toBe("forfeited");
    // p1 reconnected in time — still present, same as the pre-existing forfeit behavior.
    expect(playerStatus(forfeited, "p1")).toBe("in-game");
  });

  it("only the reconnected identity remains if the disconnected player rejoins under a new session before the match resolves", () => {
    let state = startHumanMatch(rngAlwaysA);
    ({ state } = handleAction(state, { type: "DISCONNECT", playerId: "p1" }, NOW));
    // p1 reconnects under a brand-new session/playerId (no Socket.IO recovery) and re-joins.
    ({ state } = join(state, "p1-new", "Alice"));

    const { state: forfeited } = handleAction(state, { type: "FORFEIT", matchId: "m1", playerId: "p1" }, NOW);
    expect(playerStatus(forfeited, "p1")).toBeNull(); // stale identity gone
    expect(playerStatus(forfeited, "p1-new")).toBe("available"); // reconnected identity remains
  });
});
