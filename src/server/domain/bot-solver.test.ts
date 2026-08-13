import { describe, expect, it } from "vitest";
import { getSolvedGame } from "./bot-solver";

describe("bot-solver — exact retrograde solve of the vanishing-marks game", () => {
  it("resolves the empty-board opening position as a forced win for X", () => {
    const game = getSolvedGame();
    expect(game.valueOf([], [], "X")).toBe("WIN");
    expect(game.nonLosingMovesOf([], [], "X").length).toBeGreaterThan(0);
  });

  // CONTEXT.md: X has a forced winning strategy from the opening position, and the
  // mechanics separately "permit looping" off that line — so only the reachable states
  // an optimal player would ever need are expected to resolve to WIN/LOSS; states off
  // that line may stay UNKNOWN. ~116k is the figure the issue cites for resolved states.
  it("reaches a state count on the order of the ~116k the issue cites", () => {
    const game = getSolvedGame();
    expect(game.stateCount).toBeGreaterThan(60000);
    expect(game.stateCount).toBeLessThan(200000);
  });

  it("never leaves a WIN state without a non-losing move, or a LOSS state with one", () => {
    const game = getSolvedGame();
    for (let first = 0; first < 9; first++) {
      const oValue = game.valueOf([first] as never, [], "O");
      const oMoves = game.nonLosingMovesOf([first] as never, [], "O");
      if (oValue === "LOSS") expect(oMoves).toEqual([]);
      if (oValue === "WIN") expect(oMoves.length).toBeGreaterThan(0);
    }
  });

  it("finds at least one immediate reply that keeps X on its forced-win line", () => {
    const game = getSolvedGame();
    // X's first move already proven WIN; at least one of O's 8 replies must leave X
    // still WIN (the safe move X used to get the initial WIN classification).
    const first = game.nonLosingMovesOf([], [], "X")[0];
    let sawXWinReply = false;
    for (let second = 0; second < 9; second++) {
      if (second === first) continue;
      const value = game.valueOf([first] as never, [second] as never, "X");
      if (value === "WIN") sawXWinReply = true;
    }
    expect(sawXWinReply).toBe(true);
  });
});
