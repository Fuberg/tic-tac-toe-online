// Ported from src/game/match-logic.prototype.html — the vanishing-marks rule, the
// no-rematch-after-forfeit rule, and the rematch-swaps-seats rule were verified there
// (per that file's own "lifts into the real codebase as-is" banner) and are not
// re-derived here.
import type { Cell, Mark, MatchAction, MatchEvent, MatchResult, MatchState } from "./match.types";

const WIN_LINES: Cell[][] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function other(symbol: Mark): Mark {
  return symbol === "X" ? "O" : "X";
}

export function checkWin(board: (Mark | null)[], symbol: Mark): Cell[] | null {
  for (const line of WIN_LINES) {
    if (line.every((i) => board[i] === symbol)) return line;
  }
  return null;
}

export function createMatch(seatA: Mark): MatchState {
  return {
    board: Array(9).fill(null),
    marks: { X: [], O: [] },
    currentPlayer: "X", // X always moves first
    seatA,
    seatB: other(seatA),
    moveCount: 0,
    status: "in-progress",
    winner: null,
    winningLine: null,
    lastRemovedCell: null,
  };
}

export function reduceMatch(state: MatchState, action: MatchAction): MatchResult {
  switch (action.type) {
    case "PLACE":
      return place(state, action.cell);
    case "FORFEIT":
      return forfeit(state, action.bySymbol);
    case "REMATCH":
      return rematch(state);
    case "NEW_MATCH":
      return { state: createMatch(action.seatA), events: [{ type: "MATCH_STARTED", seatA: action.seatA, seatB: other(action.seatA) }] };
    default:
      return { state, events: [] };
  }
}

function place(state: MatchState, cell: Cell): MatchResult {
  if (state.status !== "in-progress") {
    return { state, events: [{ type: "MOVE_REJECTED", reason: "match-over" }] };
  }
  if (state.board[cell] != null) {
    return { state, events: [{ type: "MOVE_REJECTED", reason: "cell-occupied" }] };
  }

  const symbol = state.currentPlayer;
  const board = state.board.slice();
  board[cell] = symbol;

  const queue = state.marks[symbol].concat(cell);
  let removedCell: Cell | null = null;
  if (queue.length > 3) {
    removedCell = queue.shift() ?? null;
    if (removedCell != null) board[removedCell] = null;
  }
  const marks = { ...state.marks, [symbol]: queue };

  const winningLine = checkWin(board, symbol);
  const moveCount = state.moveCount + 1;

  const next: MatchState = {
    ...state,
    board,
    marks,
    moveCount,
    lastRemovedCell: removedCell,
  };

  if (winningLine) {
    return {
      state: { ...next, status: "won", winner: symbol, winningLine },
      events: [{ type: "MATCH_WON", winner: symbol, winningLine }],
    };
  }

  const events: MatchEvent[] = [];
  if (removedCell != null) {
    events.push({ type: "MARK_VANISHED", symbol, cell: removedCell });
  }
  return { state: { ...next, currentPlayer: other(symbol) }, events };
}

function forfeit(state: MatchState, bySymbol: Mark): MatchResult {
  if (state.status !== "in-progress") {
    return { state, events: [] };
  }
  const winner = other(bySymbol);
  return {
    state: { ...state, status: "forfeited", winner, lastRemovedCell: null },
    events: [{ type: "MATCH_FORFEITED", bySymbol, winner }],
  };
}

function rematch(state: MatchState): MatchResult {
  if (state.status !== "won") {
    const reason = state.status === "in-progress" ? "match-in-progress" : "forfeited-match";
    return { state, events: [{ type: "REMATCH_REJECTED", reason }] };
  }
  const seatA = other(state.seatA);
  const fresh = createMatch(seatA);
  return { state: fresh, events: [{ type: "MATCH_STARTED", seatA: fresh.seatA, seatB: fresh.seatB }] };
}
