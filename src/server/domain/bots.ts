import { getSolvedGame } from "./bot-solver";
import type { Cell, Mark, MatchState } from "./match.types";

export type BotDifficulty = "easy" | "medium" | "hard";

export const BOT_DIFFICULTIES: BotDifficulty[] = ["easy", "medium", "hard"];

// CONTEXT.md / issue #1: "оптимальный решённый ход в ~70-75% случаев".
const MEDIUM_OPTIMAL_PROBABILITY = 0.725;

function legalCells(board: (Mark | null)[]): Cell[] {
  const cells: Cell[] = [];
  for (let i = 0; i < 9; i++) if (board[i] == null) cells.push(i as Cell);
  return cells;
}

function pick<T>(items: readonly T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

/**
 * Chooses a bot's move for an in-progress match, using the cached exact solve from
 * bot-solver.ts rather than searching the game tree at move time.
 *
 * - easy: uniformly random legal move; ignores the solve entirely.
 * - hard: always a move proven not to hand the opponent a forced win — this makes it
 *   unbeatable playing X, since X has a forced win from the opening (bot-solver.test.ts).
 * - medium: plays a proven-safe move ~70-75% of the time; otherwise plays a fully random
 *   legal move, which may be a mistake. This reads the issue's "otherwise a random
 *   non-losing move" as shorthand rather than literally: a medium bot that only ever
 *   chose among *provably* non-losing moves would be exactly as unbeatable as hard when
 *   playing X, which contradicts "feels winnable, but hard" (user story 26) — so the
 *   fallback branch draws from every legal move, not the solved-safe subset.
 */
export function chooseBotMove(
  state: Pick<MatchState, "board" | "marks" | "currentPlayer">,
  difficulty: BotDifficulty,
  rng: () => number = Math.random,
): Cell {
  const legal = legalCells(state.board);
  if (legal.length === 0) {
    throw new Error("chooseBotMove called with no legal moves available");
  }

  if (difficulty === "easy") {
    return pick(legal, rng);
  }

  const game = getSolvedGame();
  const nonLosing = game.nonLosingMovesOf(state.marks.X, state.marks.O, state.currentPlayer);
  const safePool = nonLosing.length > 0 ? nonLosing : legal;

  if (difficulty === "hard") {
    return pick(safePool, rng);
  }

  if (rng() < MEDIUM_OPTIMAL_PROBABILITY) {
    return pick(safePool, rng);
  }
  return pick(legal, rng);
}
