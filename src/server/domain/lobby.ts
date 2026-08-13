// The single seam described in issue #1: handleAction(state, action, now) -> { state, events }.
// One extension over the issue's literal signature — an injected `rng` alongside `now` — for
// the same reason `now` itself is injected: seat assignment (CONTEXT.md: who gets X vs O on
// the first match of a pair is random) and bot move selection both need controllable
// randomness to keep this reducer synchronously, deterministically testable.
import { chooseBotMove } from "./bots";
import { createMatch, reduceMatch } from "./match";
import type { Cell, Mark, MatchState } from "./match.types";
import type {
  LobbyAction,
  LobbyEvent,
  LobbyResult,
  LobbyState,
  MatchEntry,
  ParticipantRef,
  PlayerStatus,
  SeatKey,
} from "./lobby.types";
import { reexportMatchEvent } from "./lobby.types";

export const LOBBY_TIMEOUT_MS = 5_000;
export const MATCH_TIMEOUT_MS = 10_000;
// Not given a specific number by CONTEXT.md/issue #1 (only that it's one shared deadline,
// not two independent timers) — 15s chosen as a reasonable UX default for build time.
export const CHALLENGE_DEADLINE_MS = 15_000;

export function createEmptyLobbyState(): LobbyState {
  return { players: {}, challenges: {}, matches: {}, challengeOfPlayer: {}, matchOfPlayer: {} };
}

export function playerStatus(state: LobbyState, playerId: string): PlayerStatus | null {
  if (!state.players[playerId]) return null;
  if (state.matchOfPlayer[playerId]) return "in-game";
  if (state.challengeOfPlayer[playerId]) return "busy";
  return "available";
}

function findSeat(entry: MatchEntry, playerId: string): SeatKey | null {
  if (entry.seatA.type === "player" && entry.seatA.playerId === playerId) return "seatA";
  if (entry.seatB.type === "player" && entry.seatB.playerId === playerId) return "seatB";
  return null;
}

function markOfSeat(match: MatchState, seat: SeatKey): Mark {
  return seat === "seatA" ? match.seatA : match.seatB;
}

function participantOfSeat(entry: MatchEntry, seat: SeatKey): ParticipantRef {
  return seat === "seatA" ? entry.seatA : entry.seatB;
}

function rejected(state: LobbyState, reason: string): LobbyResult {
  return { state, events: [{ type: "ACTION_REJECTED", reason }] };
}

export function handleAction(
  state: LobbyState,
  action: LobbyAction,
  now: number,
  rng: () => number = Math.random,
): LobbyResult {
  switch (action.type) {
    case "JOIN_LOBBY":
      return joinLobby(state, action.playerId, action.nickname);
    case "LEAVE_LOBBY":
      return leaveLobby(state, action.playerId);
    case "SEND_CHALLENGE":
      return sendChallenge(state, action.challengeId, action.fromPlayerId, action.toPlayerId, now);
    case "ACCEPT_CHALLENGE":
      return acceptChallenge(state, action.challengeId, action.matchId, rng);
    case "DECLINE_CHALLENGE":
      return declineChallenge(state, action.challengeId);
    case "CHALLENGE_TIMEOUT":
      return challengeTimeout(state, action.challengeId);
    case "START_BOT_MATCH":
      return startBotMatch(state, action.matchId, action.playerId, action.difficulty, rng);
    case "PLACE":
      return place(state, action.matchId, action.playerId, action.cell);
    case "REQUEST_BOT_MOVE":
      return requestBotMove(state, action.matchId, rng);
    case "FORFEIT":
      return forfeit(state, action.matchId, action.playerId);
    case "REQUEST_REMATCH":
      return requestRematch(state, action.matchId, action.playerId);
    case "LEAVE_MATCH":
      return leaveMatch(state, action.matchId, action.playerId);
    default:
      return { state, events: [] };
  }
}

function joinLobby(state: LobbyState, playerId: string, nickname: string): LobbyResult {
  const player = { id: playerId, nickname };
  return {
    state: { ...state, players: { ...state.players, [playerId]: player } },
    events: [{ type: "PLAYER_JOINED", player }],
  };
}

function leaveLobby(state: LobbyState, playerId: string): LobbyResult {
  if (!state.players[playerId]) return { state, events: [] };
  if (state.matchOfPlayer[playerId]) return rejected(state, "in-match");

  const events: LobbyEvent[] = [];
  let { challenges, challengeOfPlayer } = state;
  const challengeId = challengeOfPlayer[playerId];
  if (challengeId) {
    const challenge = challenges[challengeId];
    challenges = omit(challenges, challengeId);
    challengeOfPlayer = omit(omit(challengeOfPlayer, challenge.fromPlayerId), challenge.toPlayerId);
    events.push({ type: "CHALLENGE_DECLINED", challengeId });
  }

  const players = omit(state.players, playerId);
  events.push({ type: "PLAYER_LEFT", playerId });

  return { state: { ...state, players, challenges, challengeOfPlayer }, events };
}

function sendChallenge(
  state: LobbyState,
  challengeId: string,
  fromPlayerId: string,
  toPlayerId: string,
  now: number,
): LobbyResult {
  const rejectChallenge = (
    reason: "sender-unavailable" | "target-unavailable" | "target-not-found" | "self-challenge",
  ) => ({ state, events: [{ type: "CHALLENGE_REJECTED", fromPlayerId, toPlayerId, reason }] }) as LobbyResult;

  if (fromPlayerId === toPlayerId) return rejectChallenge("self-challenge");
  if (!state.players[toPlayerId]) return rejectChallenge("target-not-found");
  if (playerStatus(state, fromPlayerId) !== "available") return rejectChallenge("sender-unavailable");
  if (playerStatus(state, toPlayerId) !== "available") return rejectChallenge("target-unavailable");

  const challenge = { id: challengeId, fromPlayerId, toPlayerId, deadline: now + CHALLENGE_DEADLINE_MS };
  return {
    state: {
      ...state,
      challenges: { ...state.challenges, [challengeId]: challenge },
      challengeOfPlayer: {
        ...state.challengeOfPlayer,
        [fromPlayerId]: challengeId,
        [toPlayerId]: challengeId,
      },
    },
    events: [{ type: "CHALLENGE_CREATED", challenge }],
  };
}

function acceptChallenge(
  state: LobbyState,
  challengeId: string,
  matchId: string,
  rng: () => number,
): LobbyResult {
  const challenge = state.challenges[challengeId];
  if (!challenge) return rejected(state, "challenge-not-found");

  const { entry, state: withMatch } = startMatch(
    state,
    matchId,
    { type: "player", playerId: challenge.fromPlayerId },
    { type: "player", playerId: challenge.toPlayerId },
    rng,
  );

  const challenges = omit(withMatch.challenges, challengeId);
  const challengeOfPlayer = omit(
    omit(withMatch.challengeOfPlayer, challenge.fromPlayerId),
    challenge.toPlayerId,
  );

  return {
    state: { ...withMatch, challenges, challengeOfPlayer },
    events: [
      { type: "CHALLENGE_ACCEPTED", challengeId, matchId },
      { type: "MATCH_STARTED", matchId, seatA: entry.seatA, seatB: entry.seatB },
    ],
  };
}

function declineChallenge(state: LobbyState, challengeId: string): LobbyResult {
  const challenge = state.challenges[challengeId];
  if (!challenge) return rejected(state, "challenge-not-found");
  const challenges = omit(state.challenges, challengeId);
  const challengeOfPlayer = omit(omit(state.challengeOfPlayer, challenge.fromPlayerId), challenge.toPlayerId);
  return {
    state: { ...state, challenges, challengeOfPlayer },
    events: [{ type: "CHALLENGE_DECLINED", challengeId }],
  };
}

function challengeTimeout(state: LobbyState, challengeId: string): LobbyResult {
  const challenge = state.challenges[challengeId];
  if (!challenge) return { state, events: [] }; // already resolved by an accept/decline race
  const challenges = omit(state.challenges, challengeId);
  const challengeOfPlayer = omit(omit(state.challengeOfPlayer, challenge.fromPlayerId), challenge.toPlayerId);
  return {
    state: { ...state, challenges, challengeOfPlayer },
    events: [{ type: "CHALLENGE_EXPIRED", challengeId }],
  };
}

function startBotMatch(
  state: LobbyState,
  matchId: string,
  playerId: string,
  difficulty: import("./bots").BotDifficulty,
  rng: () => number,
): LobbyResult {
  if (playerStatus(state, playerId) !== "available") return rejected(state, "player-unavailable");

  const { entry, state: withMatch } = startMatch(
    state,
    matchId,
    { type: "player", playerId },
    { type: "bot", difficulty },
    rng,
  );

  return {
    state: withMatch,
    events: [{ type: "MATCH_STARTED", matchId, seatA: entry.seatA, seatB: entry.seatB }],
  };
}

function startMatch(
  state: LobbyState,
  matchId: string,
  a: ParticipantRef,
  b: ParticipantRef,
  rng: () => number,
): { entry: MatchEntry; state: LobbyState } {
  const seatAMark: Mark = rng() < 0.5 ? "X" : "O";
  const entry: MatchEntry = {
    id: matchId,
    seatA: a,
    seatB: b,
    match: createMatch(seatAMark),
    rematchRequestedBy: null,
  };

  let matchOfPlayer = state.matchOfPlayer;
  if (a.type === "player") matchOfPlayer = { ...matchOfPlayer, [a.playerId]: matchId };
  if (b.type === "player") matchOfPlayer = { ...matchOfPlayer, [b.playerId]: matchId };

  return {
    entry,
    state: { ...state, matches: { ...state.matches, [matchId]: entry }, matchOfPlayer },
  };
}

function place(state: LobbyState, matchId: string, playerId: string, cell: Cell): LobbyResult {
  const entry = state.matches[matchId];
  if (!entry) return rejected(state, "match-not-found");
  const seat = findSeat(entry, playerId);
  if (!seat) return rejected(state, "not-a-participant");
  if (markOfSeat(entry.match, seat) !== entry.match.currentPlayer) return rejected(state, "not-your-turn");

  return applyMatchAction(state, entry, { type: "PLACE", cell });
}

function requestBotMove(state: LobbyState, matchId: string, rng: () => number): LobbyResult {
  const entry = state.matches[matchId];
  if (!entry) return rejected(state, "match-not-found");
  if (entry.match.status !== "in-progress") return rejected(state, "match-over");

  const moverSeat: SeatKey = entry.match.currentPlayer === entry.match.seatA ? "seatA" : "seatB";
  const participant = participantOfSeat(entry, moverSeat);
  if (participant.type !== "bot") return rejected(state, "not-bots-turn");

  const cell = chooseBotMove(entry.match, participant.difficulty, rng);
  return applyMatchAction(state, entry, { type: "PLACE", cell });
}

function applyMatchAction(
  state: LobbyState,
  entry: MatchEntry,
  action: Parameters<typeof reduceMatch>[1],
): LobbyResult {
  const { state: nextMatch, events: matchEvents } = reduceMatch(entry.match, action);
  const nextEntry: MatchEntry = { ...entry, match: nextMatch };
  const reexported = matchEvents
    .map((e) => reexportMatchEvent(entry.id, e))
    .filter((e): e is LobbyEvent => e != null);
  // A legal move with no vanish and no win produces no match.ts event at all — fall back to
  // a generic one so the transport still knows to broadcast the updated board/turn.
  const events = reexported.length > 0 ? reexported : [{ type: "MATCH_STATE_CHANGED" as const, matchId: entry.id }];

  return {
    state: { ...state, matches: { ...state.matches, [entry.id]: nextEntry } },
    events,
  };
}

function forfeit(state: LobbyState, matchId: string, playerId: string): LobbyResult {
  const entry = state.matches[matchId];
  if (!entry) return rejected(state, "match-not-found");
  if (entry.match.status !== "in-progress") return { state, events: [] }; // already resolved

  const seat = findSeat(entry, playerId);
  if (!seat) return rejected(state, "not-a-participant");

  return applyMatchAction(state, entry, { type: "FORFEIT", bySymbol: markOfSeat(entry.match, seat) });
}

function requestRematch(state: LobbyState, matchId: string, playerId: string): LobbyResult {
  const entry = state.matches[matchId];
  if (!entry) return rejected(state, "match-not-found");
  if (entry.match.status === "in-progress") return rejected(state, "match-in-progress");
  if (entry.match.status === "forfeited") return rejected(state, "forfeited-match");

  const seat = findSeat(entry, playerId);
  if (!seat) return rejected(state, "not-a-participant");
  if (entry.rematchRequestedBy === seat) return rejected(state, "already-requested");

  if (entry.rematchRequestedBy === null) {
    const nextEntry: MatchEntry = { ...entry, rematchRequestedBy: seat };
    return {
      state: { ...state, matches: { ...state.matches, [matchId]: nextEntry } },
      events: [{ type: "REMATCH_REQUESTED", matchId, bySeat: seat }],
    };
  }

  // Other seat already asked — both agreed, start the swapped-seats rematch.
  const { state: rematched } = reduceMatch(entry.match, { type: "REMATCH" });
  const nextEntry: MatchEntry = { ...entry, match: rematched, rematchRequestedBy: null };
  return {
    state: { ...state, matches: { ...state.matches, [matchId]: nextEntry } },
    events: [{ type: "MATCH_STARTED", matchId, seatA: entry.seatA, seatB: entry.seatB }],
  };
}

function leaveMatch(state: LobbyState, matchId: string, playerId: string): LobbyResult {
  const entry = state.matches[matchId];
  if (!entry) return rejected(state, "match-not-found");
  if (entry.match.status === "in-progress") return rejected(state, "match-in-progress");

  const seat = findSeat(entry, playerId);
  if (!seat) return rejected(state, "not-a-participant");

  const matches = omit(state.matches, matchId);
  let matchOfPlayer = state.matchOfPlayer;
  if (entry.seatA.type === "player") matchOfPlayer = omit(matchOfPlayer, entry.seatA.playerId);
  if (entry.seatB.type === "player") matchOfPlayer = omit(matchOfPlayer, entry.seatB.playerId);

  return {
    state: { ...state, matches, matchOfPlayer },
    events: [{ type: "MATCH_ENDED", matchId }],
  };
}

function omit<T extends Record<string, unknown>>(obj: T, key: string): T {
  if (!(key in obj)) return obj;
  const next = { ...obj };
  delete next[key];
  return next;
}
