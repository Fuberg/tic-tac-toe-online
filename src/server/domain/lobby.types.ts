import type { BotDifficulty } from "./bots";
import type { Cell, Mark, MatchEvent, MatchState } from "./match.types";

export interface Player {
  id: string;
  nickname: string;
}

export type ParticipantRef =
  | { type: "player"; playerId: string }
  | { type: "bot"; difficulty: BotDifficulty };

export type SeatKey = "seatA" | "seatB";

export interface PendingChallenge {
  id: string;
  fromPlayerId: string;
  toPlayerId: string;
  deadline: number;
}

export interface MatchEntry {
  id: string;
  seatA: ParticipantRef;
  seatB: ParticipantRef;
  match: MatchState;
  /** Seat that has asked for a rematch on the result screen, awaiting the other seat. */
  rematchRequestedBy: SeatKey | null;
}

export interface LobbyState {
  players: Record<string, Player>;
  challenges: Record<string, PendingChallenge>;
  matches: Record<string, MatchEntry>;
  /** playerId -> challengeId, for a challenge they sent or received (at most one). */
  challengeOfPlayer: Record<string, string>;
  /** playerId -> matchId, for their single active match, including its result screen. */
  matchOfPlayer: Record<string, string>;
}

export type PlayerStatus = "available" | "busy" | "in-game";

export type LobbyAction =
  | { type: "JOIN_LOBBY"; playerId: string; nickname: string }
  | { type: "LEAVE_LOBBY"; playerId: string }
  | { type: "SEND_CHALLENGE"; challengeId: string; fromPlayerId: string; toPlayerId: string }
  | { type: "ACCEPT_CHALLENGE"; challengeId: string; matchId: string; playerId: string }
  | { type: "DECLINE_CHALLENGE"; challengeId: string; playerId: string }
  | { type: "CHALLENGE_TIMEOUT"; challengeId: string }
  | { type: "START_BOT_MATCH"; matchId: string; playerId: string; difficulty: BotDifficulty }
  | { type: "PLACE"; matchId: string; playerId: string; cell: Cell }
  | { type: "REQUEST_BOT_MOVE"; matchId: string }
  | { type: "FORFEIT"; matchId: string; playerId: string }
  | { type: "REQUEST_REMATCH"; matchId: string; playerId: string }
  | { type: "LEAVE_MATCH"; matchId: string; playerId: string };

/** Closed set of reasons an action can be rejected for, across every action type — kept as
 * one union (rather than per-action ones) since ACTION_REJECTED is a deliberate catch-all. */
export type RejectReason =
  | "in-match"
  | "match-not-found"
  | "not-a-participant"
  | "not-your-turn"
  | "not-bots-turn"
  | "match-over"
  | "player-unavailable"
  | "match-in-progress"
  | "forfeited-match"
  | "already-requested"
  | "challenge-not-found"
  | "not-the-target";

export type LobbyEvent =
  | { type: "PLAYER_JOINED"; player: Player }
  | { type: "PLAYER_LEFT"; playerId: string }
  | { type: "CHALLENGE_CREATED"; challenge: PendingChallenge }
  | {
      type: "CHALLENGE_REJECTED";
      fromPlayerId: string;
      toPlayerId: string;
      reason: "sender-unavailable" | "target-unavailable" | "target-not-found" | "self-challenge";
    }
  // These four carry the full PendingChallenge (not just its id) so the transport can notify
  // exactly the two players involved without a separate state lookup.
  | { type: "CHALLENGE_ACCEPTED"; challenge: PendingChallenge; matchId: string }
  | { type: "CHALLENGE_DECLINED"; challenge: PendingChallenge }
  /** CONTEXT.md distinguishes an explicit decline from a challenge disappearing because a
   * participant left the lobby (or was removed by lobby-timeout) before it was answered. */
  | { type: "CHALLENGE_CANCELLED"; challenge: PendingChallenge; reason: "challenger-left" | "target-left" }
  | { type: "CHALLENGE_EXPIRED"; challenge: PendingChallenge }
  | { type: "MATCH_STARTED"; matchId: string; seatA: ParticipantRef; seatB: ParticipantRef }
  /** An ordinary move with nothing narratively notable (no vanish, no win) — the transport
   * still needs to know the match changed so it can broadcast the new board/turn. */
  | { type: "MATCH_STATE_CHANGED"; matchId: string }
  | { type: "MATCH_MOVE_REJECTED"; matchId: string; reason: "match-over" | "cell-occupied" }
  | { type: "MARK_VANISHED"; matchId: string; symbol: Mark; cell: Cell }
  | { type: "MATCH_WON"; matchId: string; winner: Mark; winningLine: Cell[] }
  | { type: "MATCH_FORFEITED"; matchId: string; bySymbol: Mark; winner: Mark }
  | { type: "REMATCH_REQUESTED"; matchId: string; bySeat: SeatKey }
  | { type: "REMATCH_REJECTED"; matchId: string; reason: "match-in-progress" | "forfeited-match" }
  | { type: "MATCH_ENDED"; matchId: string }
  | { type: "ACTION_REJECTED"; reason: RejectReason };

export interface LobbyResult {
  state: LobbyState;
  events: LobbyEvent[];
}

export function reexportMatchEvent(matchId: string, event: MatchEvent): LobbyEvent | null {
  switch (event.type) {
    case "MARK_VANISHED":
      return { type: "MARK_VANISHED", matchId, symbol: event.symbol, cell: event.cell };
    case "MATCH_WON":
      return { type: "MATCH_WON", matchId, winner: event.winner, winningLine: event.winningLine };
    case "MATCH_FORFEITED":
      return { type: "MATCH_FORFEITED", matchId, bySymbol: event.bySymbol, winner: event.winner };
    case "MOVE_REJECTED":
      return { type: "MATCH_MOVE_REJECTED", matchId, reason: event.reason };
    default:
      return null;
  }
}
