// Thin Socket.IO adapter around the domain reducer (src/server/domain/lobby.ts). Per the
// issue's seam decision, this file owns I/O only — playerId/matchId/challengeId generation,
// room membership, and *_TIMEOUT scheduling — and never re-implements lobby/challenge/match
// rules. Gets a light smoke-test pass (see game-server.smoke.test.ts), not the bulk of the
// test investment; that lives on the reducer.
import { randomUUID } from "node:crypto";
import type { Server, Socket } from "socket.io";
import { BOT_DIFFICULTIES, type BotDifficulty } from "../domain/bots";
import {
  LOBBY_TIMEOUT_MS,
  MATCH_TIMEOUT_MS,
  createEmptyLobbyState,
  handleAction,
  matchParticipants,
  playerStatus,
} from "../domain/lobby";
import type { Cell } from "../domain/match.types";
import type { LobbyAction, LobbyEvent, LobbyState, PendingChallenge } from "../domain/lobby.types";

// Small delay before a bot's move broadcasts, so it doesn't feel instant/robotic. Injectable
// so tests can drive full games without waiting on it for real.
const DEFAULT_BOT_MOVE_DELAY_MS = 500;

type AckResult = { ok: true } | { ok: false; reason: string };

// The only two LobbyEvent variants that represent "the request was denied" rather than
// "something happened" — everything else is treated as a success ack.
function ackFromEvents(events: LobbyEvent[]): AckResult {
  for (const e of events) {
    if (e.type === "ACTION_REJECTED" || e.type === "CHALLENGE_REJECTED") {
      return { ok: false, reason: e.reason };
    }
  }
  return { ok: true };
}

function emitToPlayer(playerSockets: Map<string, Socket>, playerId: string, event: string, payload: unknown) {
  playerSockets.get(playerId)?.emit(event, payload);
}

function notifyChallengeParties(
  playerSockets: Map<string, Socket>,
  challenge: PendingChallenge,
  event: string,
  payload: unknown,
) {
  emitToPlayer(playerSockets, challenge.fromPlayerId, event, payload);
  emitToPlayer(playerSockets, challenge.toPlayerId, event, payload);
}

function matchRoom(matchId: string): string {
  return `match:${matchId}`;
}

function buildLobbySnapshot(state: LobbyState) {
  return {
    players: Object.values(state.players).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      status: playerStatus(state, p.id),
    })),
    bots: BOT_DIFFICULTIES.map((difficulty) => ({ id: `bot:${difficulty}`, difficulty })),
  };
}

function buildMatchSnapshot(state: LobbyState, matchId: string) {
  const entry = state.matches[matchId];
  if (!entry) return null;
  return {
    id: entry.id,
    seatA: entry.seatA,
    seatB: entry.seatB,
    match: entry.match,
    rematchRequestedBy: entry.rematchRequestedBy,
  };
}

export function attachGameServer(
  io: Server,
  options?: { botMoveDelayMs?: number; lobbyTimeoutMs?: number },
) {
  const botMoveDelayMs = options?.botMoveDelayMs ?? DEFAULT_BOT_MOVE_DELAY_MS;
  const lobbyTimeoutMs = options?.lobbyTimeoutMs ?? LOBBY_TIMEOUT_MS;
  let state: LobbyState = createEmptyLobbyState();

  const playerSockets = new Map<string, Socket>();
  const lobbyTimeoutTimers = new Map<string, NodeJS.Timeout>();
  const matchTimeoutTimers = new Map<string, NodeJS.Timeout>();
  const challengeTimeoutTimers = new Map<string, NodeJS.Timeout>();

  function dispatch(action: LobbyAction): LobbyEvent[] {
    const result = handleAction(state, action, Date.now());
    state = result.state;
    routeEvents(result.events);
    return result.events;
  }

  function routeEvents(events: LobbyEvent[]) {
    let lobbyChanged = false;
    const touchedMatches = new Set<string>();

    for (const event of events) {
      switch (event.type) {
        case "PLAYER_JOINED":
        case "PLAYER_LEFT":
        case "CHALLENGE_CREATED":
        case "CHALLENGE_ACCEPTED":
        case "CHALLENGE_DECLINED":
        case "CHALLENGE_CANCELLED":
        case "CHALLENGE_EXPIRED":
          lobbyChanged = true;
          break;
        case "MATCH_STARTED":
        case "MATCH_WON":
        case "MATCH_FORFEITED":
        case "MATCH_ENDED":
          lobbyChanged = true;
          touchedMatches.add(event.matchId);
          break;
        case "MATCH_STATE_CHANGED":
        case "MATCH_MOVE_REJECTED":
        case "MARK_VANISHED":
        case "REMATCH_REQUESTED":
        case "REMATCH_REJECTED":
          touchedMatches.add(event.matchId);
          break;
        default:
          break;
      }

      // CHALLENGE_REJECTED never changes state (it's a same-tick denial of the sender's own
      // request, answered via that request's ack) — deliberately not routed here.

      if (event.type === "CHALLENGE_CREATED") {
        const { id, deadline } = event.challenge;
        const delay = Math.max(0, deadline - Date.now());
        challengeTimeoutTimers.set(
          id,
          setTimeout(() => dispatch({ type: "CHALLENGE_TIMEOUT", challengeId: id }), delay),
        );
        notifyChallengeParties(playerSockets, event.challenge, "challenge:pending", event.challenge);
      }
      if (
        event.type === "CHALLENGE_ACCEPTED" ||
        event.type === "CHALLENGE_DECLINED" ||
        event.type === "CHALLENGE_CANCELLED" ||
        event.type === "CHALLENGE_EXPIRED"
      ) {
        const timer = challengeTimeoutTimers.get(event.challenge.id);
        if (timer) {
          clearTimeout(timer);
          challengeTimeoutTimers.delete(event.challenge.id);
        }
        const outcome =
          event.type === "CHALLENGE_ACCEPTED"
            ? "accepted"
            : event.type === "CHALLENGE_DECLINED"
              ? "declined"
              : event.type === "CHALLENGE_EXPIRED"
                ? "expired"
                : event.reason; // CANCELLED: "challenger-left" | "target-left"
        notifyChallengeParties(playerSockets, event.challenge, "challenge:resolved", {
          challengeId: event.challenge.id,
          outcome,
        });
      }
      if (event.type === "MATCH_STARTED") {
        for (const [, participant] of matchParticipants(event)) {
          if (participant.type === "player") playerSockets.get(participant.playerId)?.join(matchRoom(event.matchId));
        }
      }
    }

    for (const matchId of touchedMatches) {
      io.to(matchRoom(matchId)).emit("match:update", buildMatchSnapshot(state, matchId));
      scheduleBotMoveIfNeeded(matchId);
    }
    if (lobbyChanged) {
      io.to("lobby").emit("lobby:update", buildLobbySnapshot(state));
    }
  }

  function scheduleBotMoveIfNeeded(matchId: string) {
    const entry = state.matches[matchId];
    if (!entry || entry.match.status !== "in-progress") return;
    const moverSeat = entry.match.currentPlayer === entry.match.seatA ? entry.seatA : entry.seatB;
    if (moverSeat.type !== "bot") return;
    setTimeout(() => dispatch({ type: "REQUEST_BOT_MOVE", matchId }), botMoveDelayMs);
  }

  function clearLobbyTimer(playerId: string) {
    const timer = lobbyTimeoutTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      lobbyTimeoutTimers.delete(playerId);
    }
  }

  function clearMatchTimer(playerId: string) {
    const timer = matchTimeoutTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      matchTimeoutTimers.delete(playerId);
    }
  }

  io.on("connection", (socket) => {
    const playerId = socket.id;
    playerSockets.set(playerId, socket);
    socket.join("lobby");

    if (socket.recovered) {
      clearMatchTimer(playerId);
      const matchId = state.matchOfPlayer[playerId];
      if (matchId) socket.join(matchRoom(matchId));
      socket.emit("lobby:update", buildLobbySnapshot(state));
      if (matchId) socket.emit("match:update", buildMatchSnapshot(state, matchId));
    }

    socket.on("lobby:join", (payload: { nickname?: unknown }, ack?: (r: AckResult) => void) => {
      const nickname = typeof payload?.nickname === "string" ? payload.nickname.trim().slice(0, 32) : "";
      if (!nickname) return ack?.({ ok: false, reason: "invalid-nickname" });
      ack?.(ackFromEvents(dispatch({ type: "JOIN_LOBBY", playerId, nickname })));
    });

    socket.on("lobby:leave", (_payload: unknown, ack?: (r: AckResult) => void) => {
      ack?.(ackFromEvents(dispatch({ type: "LEAVE_LOBBY", playerId })));
    });

    // The client sends this on document visibilitychange — a hidden (not closed) tab starts
    // the lobby-timeout clock; becoming visible again before it fires cancels the removal.
    socket.on("lobby:visibility", (payload: { hidden?: unknown }) => {
      if (payload?.hidden) {
        clearLobbyTimer(playerId);
        lobbyTimeoutTimers.set(
          playerId,
          setTimeout(() => {
            lobbyTimeoutTimers.delete(playerId);
            dispatch({ type: "LEAVE_LOBBY", playerId });
          }, lobbyTimeoutMs),
        );
      } else {
        clearLobbyTimer(playerId);
      }
    });

    socket.on(
      "challenge:send",
      (payload: { toPlayerId?: unknown }, ack?: (r: AckResult) => void) => {
        const toPlayerId = typeof payload?.toPlayerId === "string" ? payload.toPlayerId : "";
        ack?.(
          ackFromEvents(
            dispatch({ type: "SEND_CHALLENGE", challengeId: randomUUID(), fromPlayerId: playerId, toPlayerId }),
          ),
        );
      },
    );

    socket.on(
      "challenge:accept",
      (payload: { challengeId?: unknown }, ack?: (r: AckResult) => void) => {
        const challengeId = typeof payload?.challengeId === "string" ? payload.challengeId : "";
        ack?.(
          ackFromEvents(
            dispatch({ type: "ACCEPT_CHALLENGE", challengeId, matchId: randomUUID(), playerId }),
          ),
        );
      },
    );

    socket.on(
      "challenge:decline",
      (payload: { challengeId?: unknown }, ack?: (r: AckResult) => void) => {
        const challengeId = typeof payload?.challengeId === "string" ? payload.challengeId : "";
        ack?.(ackFromEvents(dispatch({ type: "DECLINE_CHALLENGE", challengeId, playerId })));
      },
    );

    socket.on(
      "bot:start",
      (payload: { difficulty?: unknown }, ack?: (r: AckResult) => void) => {
        const difficulty = payload?.difficulty as BotDifficulty;
        if (!BOT_DIFFICULTIES.includes(difficulty)) return ack?.({ ok: false, reason: "invalid-difficulty" });
        ack?.(
          ackFromEvents(
            dispatch({ type: "START_BOT_MATCH", matchId: randomUUID(), playerId, difficulty }),
          ),
        );
      },
    );

    socket.on(
      "match:place",
      (payload: { matchId?: unknown; cell?: unknown }, ack?: (r: AckResult) => void) => {
        const matchId = typeof payload?.matchId === "string" ? payload.matchId : "";
        const cell = payload?.cell;
        if (typeof cell !== "number" || !Number.isInteger(cell) || cell < 0 || cell > 8) {
          return ack?.({ ok: false, reason: "invalid-cell" });
        }
        ack?.(ackFromEvents(dispatch({ type: "PLACE", matchId, playerId, cell: cell as Cell })));
      },
    );

    socket.on(
      "match:requestRematch",
      (payload: { matchId?: unknown }, ack?: (r: AckResult) => void) => {
        const matchId = typeof payload?.matchId === "string" ? payload.matchId : "";
        ack?.(ackFromEvents(dispatch({ type: "REQUEST_REMATCH", matchId, playerId })));
      },
    );

    socket.on(
      "match:leave",
      (payload: { matchId?: unknown }, ack?: (r: AckResult) => void) => {
        const matchId = typeof payload?.matchId === "string" ? payload.matchId : "";
        const entry = state.matches[matchId];
        const events = dispatch({ type: "LEAVE_MATCH", matchId, playerId });
        if (entry && events.some((e) => e.type === "MATCH_ENDED")) {
          for (const [, participant] of matchParticipants(entry)) {
            if (participant.type === "player") playerSockets.get(participant.playerId)?.leave(matchRoom(matchId));
          }
        }
        ack?.(ackFromEvents(events));
      },
    );

    socket.on("disconnect", () => {
      playerSockets.delete(playerId);
      clearLobbyTimer(playerId);

      const matchId = state.matchOfPlayer[playerId];
      if (matchId && state.matches[matchId]?.match.status === "in-progress") {
        matchTimeoutTimers.set(
          playerId,
          setTimeout(() => {
            matchTimeoutTimers.delete(playerId);
            dispatch({ type: "FORFEIT", matchId, playerId });
          }, MATCH_TIMEOUT_MS),
        );
      } else if (state.players[playerId]) {
        dispatch({ type: "LEAVE_LOBBY", playerId });
      }
    });
  });

  return {
    shutdown() {
      io.emit("server:shutdown", {
        message: "Сервер обновляется — вы будете возвращены на экран входа.",
      });
      for (const timer of lobbyTimeoutTimers.values()) clearTimeout(timer);
      for (const timer of matchTimeoutTimers.values()) clearTimeout(timer);
      for (const timer of challengeTimeoutTimers.values()) clearTimeout(timer);
    },
  };
}
