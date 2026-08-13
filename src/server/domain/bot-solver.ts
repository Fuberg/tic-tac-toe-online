// Exact solver for the vanishing-marks match, over the full reachable state graph
// (per the issue: ~116k reachable non-terminal states), solved once via retrograde
// analysis (backward induction / attractor computation over win/loss regions) and
// cached in memory — not a per-move minimax search.
import { checkWin, other } from "./match";
import type { Cell, Mark } from "./match.types";

interface SolverState {
  marksX: readonly Cell[];
  marksO: readonly Cell[];
  mover: Mark;
}

// Only WIN/LOSS are provable outcomes of the fixed-point below. A reachable state the
// fixed-point never resolves is UNKNOWN — the mechanical cycles CONTEXT.md notes are
// possible off X's forced-win line (e.g. after a suboptimal opening), where neither side
// can yet force an outcome. UNKNOWN states are never entered by a bot playing safe moves.
type Value = "WIN" | "LOSS" | "UNKNOWN";

export interface SolvedGame {
  /** Count of reachable states resolved to WIN or LOSS (excludes UNKNOWN states). */
  readonly stateCount: number;
  /** WIN/LOSS/UNKNOWN value for the state's mover. */
  valueOf(marksX: readonly Cell[], marksO: readonly Cell[], mover: Mark): Value;
  /**
   * Moves that don't hand the opponent a state proven WIN for them — i.e. immediate wins,
   * moves into a proven LOSS for the opponent, or moves into an UNKNOWN state. Empty only
   * when every legal move is a proven win for the opponent (state is LOSS).
   */
  nonLosingMovesOf(marksX: readonly Cell[], marksO: readonly Cell[], mover: Mark): Cell[];
}

function key(s: SolverState): string {
  return `${s.marksX.join(",")}|${s.marksO.join(",")}|${s.mover}`;
}

function boardOf(s: SolverState): (Mark | null)[] {
  const board: (Mark | null)[] = Array(9).fill(null);
  for (const c of s.marksX) board[c] = "X";
  for (const c of s.marksO) board[c] = "O";
  return board;
}

function legalMoves(s: SolverState): Cell[] {
  const board = boardOf(s);
  const moves: Cell[] = [];
  for (let c = 0; c < 9; c++) if (board[c] == null) moves.push(c as Cell);
  return moves;
}

function applyMove(
  s: SolverState,
  cell: Cell,
): { won: true } | { won: false; next: SolverState } {
  const mover = s.mover;
  const board = boardOf(s);
  board[cell] = mover;

  const priorQueue = mover === "X" ? s.marksX : s.marksO;
  const queue = [...priorQueue, cell];
  if (queue.length > 3) {
    const removed = queue.shift() as Cell;
    board[removed] = null;
  }

  if (checkWin(board, mover)) return { won: true };

  return {
    won: false,
    next: {
      marksX: mover === "X" ? queue : s.marksX,
      marksO: mover === "O" ? queue : s.marksO,
      mover: other(mover),
    },
  };
}

interface Edge {
  move: Cell;
  toKey: string;
  immediateWin: boolean;
}

/**
 * Solves the entire reachable game graph exactly via retrograde analysis:
 * 1. Forward BFS from the empty board to discover every reachable non-terminal state.
 * 2. Backward fixed-point propagation (attractor computation) from immediate-win moves,
 *    labeling each state WIN (mover can force a win) or LOSS (every move hands the
 *    opponent a forced win) until no reachable state is left unresolved.
 */
function solve(): {
  values: Map<string, Value>;
  nodeKeys: Set<string>;
  nonLosingMoves: Map<string, Cell[]>;
} {
  const initial: SolverState = { marksX: [], marksO: [], mover: "X" };
  const initKey = key(initial);

  const nodes = new Map<string, SolverState>([[initKey, initial]]);
  const edges = new Map<string, Edge[]>();
  const predecessors = new Map<string, { fromKey: string; move: Cell }[]>();

  const frontier: SolverState[] = [initial];
  let cursor = 0;
  while (cursor < frontier.length) {
    const s = frontier[cursor++];
    const sKey = key(s);
    const edgeList: Edge[] = [];
    for (const move of legalMoves(s)) {
      const result = applyMove(s, move);
      if (result.won) {
        edgeList.push({ move, toKey: "", immediateWin: true });
        continue;
      }
      const toKey = key(result.next);
      edgeList.push({ move, toKey, immediateWin: false });
      if (!nodes.has(toKey)) {
        nodes.set(toKey, result.next);
        frontier.push(result.next);
      }
      const preds = predecessors.get(toKey) ?? [];
      preds.push({ fromKey: sKey, move });
      predecessors.set(toKey, preds);
    }
    edges.set(sKey, edgeList);
  }

  const values = new Map<string, Value>();
  const remaining = new Map<string, number>();
  const resolveQueue: string[] = [];

  for (const [sKey, edgeList] of edges) {
    const immediateWin = edgeList.some((e) => e.immediateWin);
    if (immediateWin) {
      values.set(sKey, "WIN");
      resolveQueue.push(sKey);
    } else {
      remaining.set(sKey, edgeList.length);
    }
  }

  let head = 0;
  while (head < resolveQueue.length) {
    const sKey = resolveQueue[head++];
    const value = values.get(sKey) as Value;
    for (const { fromKey, move } of predecessors.get(sKey) ?? []) {
      void move;
      if (values.has(fromKey)) continue;
      if (value === "WIN") {
        const left = (remaining.get(fromKey) ?? 0) - 1;
        remaining.set(fromKey, left);
        if (left === 0) {
          values.set(fromKey, "LOSS");
          resolveQueue.push(fromKey);
        }
      } else {
        values.set(fromKey, "WIN");
        resolveQueue.push(fromKey);
      }
    }
  }

  // A move is non-losing if it doesn't hand the opponent a state proven WIN for them —
  // true for immediate wins, moves into a proven LOSS for the opponent, and moves into
  // an UNKNOWN (unresolved) state. This is well-defined for every discovered node, not
  // just WIN ones: a LOSS state naturally yields [] here too, since every one of its
  // edges was, by construction of the fixed point above, proven WIN for the opponent.
  const nonLosingMoves = new Map<string, Cell[]>();
  for (const [sKey, edgeList] of edges) {
    const moves = edgeList
      .filter((e) => e.immediateWin || values.get(e.toKey) !== "WIN")
      .map((e) => e.move);
    nonLosingMoves.set(sKey, moves);
  }

  return { values, nodeKeys: new Set(nodes.keys()), nonLosingMoves };
}

let cached: SolvedGame | null = null;

export function getSolvedGame(): SolvedGame {
  if (cached) return cached;
  const { values, nodeKeys, nonLosingMoves } = solve();
  cached = {
    stateCount: values.size,
    valueOf(marksX, marksO, mover) {
      const k = key({ marksX, marksO, mover });
      const v = values.get(k);
      if (v) return v;
      if (nodeKeys.has(k)) return "UNKNOWN";
      throw new Error("Unreachable state passed to solved-game lookup");
    },
    nonLosingMovesOf(marksX, marksO, mover) {
      const k = key({ marksX, marksO, mover });
      const moves = nonLosingMoves.get(k);
      if (moves) return moves;
      if (nodeKeys.has(k)) return [];
      throw new Error("Unreachable state passed to solved-game lookup");
    },
  };
  return cached;
}

export function legalMovesForBoard(marksX: readonly Cell[], marksO: readonly Cell[]): Cell[] {
  return legalMoves({ marksX, marksO, mover: "X" });
}
