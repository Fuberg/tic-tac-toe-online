export type Mark = "X" | "O";

export type Cell = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type MatchStatus = "in-progress" | "won" | "forfeited";

export interface MatchState {
  board: (Mark | null)[];
  marks: Record<Mark, Cell[]>;
  currentPlayer: Mark;
  seatA: Mark;
  seatB: Mark;
  moveCount: number;
  status: MatchStatus;
  winner: Mark | null;
  winningLine: Cell[] | null;
  lastRemovedCell: Cell | null;
}

export type MatchAction =
  | { type: "PLACE"; cell: Cell }
  | { type: "FORFEIT"; bySymbol: Mark }
  | { type: "REMATCH" }
  | { type: "NEW_MATCH"; seatA: Mark };

export type MatchEvent =
  | { type: "MOVE_REJECTED"; reason: "match-over" | "cell-occupied" }
  | { type: "MARK_VANISHED"; symbol: Mark; cell: Cell }
  | { type: "MATCH_WON"; winner: Mark; winningLine: Cell[] }
  | { type: "MATCH_FORFEITED"; bySymbol: Mark; winner: Mark }
  | { type: "REMATCH_REJECTED"; reason: "match-in-progress" | "forfeited-match" }
  | { type: "MATCH_STARTED"; seatA: Mark; seatB: Mark };

export interface MatchResult {
  state: MatchState;
  events: MatchEvent[];
}
