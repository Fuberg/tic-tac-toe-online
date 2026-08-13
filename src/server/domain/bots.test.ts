import { describe, expect, it } from "vitest";
import { getSolvedGame } from "./bot-solver";
import { chooseBotMove } from "./bots";
import { createMatch, reduceMatch } from "./match";
import type { MatchState } from "./match.types";

// Deterministic PRNG so bot-behavior tests are reproducible across runs.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function queueRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("chooseBotMove — easy", () => {
  it("picks uniformly among legal cells, ignoring the solve", () => {
    const state = createMatch("X");
    expect(chooseBotMove(state, "easy", () => 0)).toBe(0);
    expect(chooseBotMove(state, "easy", () => 0.999999)).toBe(8);
  });
});

describe("chooseBotMove — hard", () => {
  it("only ever plays a move proven non-losing for the mover", () => {
    const game = getSolvedGame();
    let state = createMatch("X");
    for (let ply = 0; ply < 6 && state.status === "in-progress"; ply++) {
      const safe = game.nonLosingMovesOf(state.marks.X, state.marks.O, state.currentPlayer);
      for (const probe of [0, 0.25, 0.5, 0.75, 0.999]) {
        const move = chooseBotMove(state, "hard", () => probe);
        expect(safe).toContain(move);
      }
      const move = chooseBotMove(state, "hard", mulberry32(ply));
      ({ state } = reduceMatch(state, { type: "PLACE", cell: move }));
    }
  });

  it("playing X, is never beaten by any sequence of legal O replies (forced-win invariant)", () => {
    for (let seed = 0; seed < 40; seed++) {
      const rngO = mulberry32(seed);
      let state: MatchState = createMatch("X");
      let guard = 0;
      while (state.status === "in-progress" && guard++ < 30) {
        const mover = state.currentPlayer;
        const move =
          mover === "X"
            ? chooseBotMove(state, "hard", mulberry32(seed * 1000 + guard))
            : legalRandomMove(state, rngO);
        ({ state } = reduceMatch(state, { type: "PLACE", cell: move }));
      }
      expect(state.status).not.toBe("in-progress");
      if (state.status === "won") {
        expect(state.winner).toBe("X");
      }
      // forfeited never happens in this simulation (no FORFEIT actions dispatched)
    }
  });
});

describe("chooseBotMove — medium", () => {
  it("takes the proven-safe pool when the optimal roll succeeds", () => {
    const state = createMatch("X");
    const safe = getSolvedGame().nonLosingMovesOf(state.marks.X, state.marks.O, "X");
    const move = chooseBotMove(state, "medium", queueRng([0, 0])); // 0 < threshold -> optimal branch
    expect(safe).toContain(move);
  });

  it("can fall back to a legal-but-unsafe move when the optimal roll fails", () => {
    // After X opens on a corner (cell 2), O's only proven-safe reply is the center (4);
    // every other legal cell is a proven loss for O (see bot-solver exploration).
    let state = createMatch("X");
    ({ state } = reduceMatch(state, { type: "PLACE", cell: 2 }));
    const safe = getSolvedGame().nonLosingMovesOf(state.marks.X, state.marks.O, "O");
    expect(safe).toEqual([4]);

    // rng: 0.99 fails the ~72.5% optimal roll -> fallback branch; second draw picks index
    // 0 of the 8 legal cells, which is cell 0 (not the safe cell 4).
    const move = chooseBotMove(state, "medium", queueRng([0.99, 0]));
    expect(move).toBe(0);
    expect(move).not.toBe(4);
  });
});

function legalRandomMove(state: MatchState, rng: () => number) {
  const cells: number[] = [];
  for (let i = 0; i < 9; i++) if (state.board[i] == null) cells.push(i);
  return cells[Math.floor(rng() * cells.length)] as never;
}
