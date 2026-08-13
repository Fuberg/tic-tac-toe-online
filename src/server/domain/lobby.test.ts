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
      { type: "ACCEPT_CHALLENGE", challengeId: "c1", matchId: "m1" },
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

  it("expires a pending challenge on CHALLENGE_TIMEOUT and frees both players", () => {
    let state = twoPlayers();
    ({ state } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    ));

    const { state: after, events } = handleAction(state, { type: "CHALLENGE_TIMEOUT", challengeId: "c1" }, NOW);
    expect(events).toEqual([{ type: "CHALLENGE_EXPIRED", challengeId: "c1" }]);
    expect(playerStatus(after, "p1")).toBe("available");
    expect(playerStatus(after, "p2")).toBe("available");
  });

  it("cancels a pending challenge when the challenger leaves the lobby", () => {
    let state = twoPlayers();
    ({ state } = handleAction(
      state,
      { type: "SEND_CHALLENGE", challengeId: "c1", fromPlayerId: "p1", toPlayerId: "p2" },
      NOW,
    ));

    const { state: after, events } = handleAction(state, { type: "LEAVE_LOBBY", playerId: "p1" }, NOW);
    expect(events).toEqual([
      { type: "CHALLENGE_DECLINED", challengeId: "c1" },
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
    ({ state } = handleAction(state, { type: "ACCEPT_CHALLENGE", challengeId: "c1", matchId: "m1" }, NOW, rng));
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
