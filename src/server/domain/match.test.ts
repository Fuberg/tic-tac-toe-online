import { describe, expect, it } from "vitest";
import { createMatch, reduceMatch } from "./match";
import type { MatchState } from "./match.types";

function place(state: MatchState, cell: number) {
  return reduceMatch(state, { type: "PLACE", cell: cell as never });
}

describe("match reducer — vanishing marks", () => {
  // Ported from src/game/match-logic.prototype.html scenario "Быстрая победа":
  // a plain win with no mark ever reaching the 4-cap, so the vanish rule never triggers.
  it("wins on three in a row with no vanish involved", () => {
    let state = createMatch("X");
    ({ state } = place(state, 0)); // X top-left
    ({ state } = place(state, 3)); // O mid-left
    ({ state } = place(state, 1)); // X top-mid
    ({ state } = place(state, 4)); // O center
    const { state: final, events } = place(state, 2); // X top-right -> win

    expect(final.status).toBe("won");
    expect(final.winner).toBe("X");
    expect(final.winningLine).toEqual([0, 1, 2]);
    expect(events).toEqual([{ type: "MATCH_WON", winner: "X", winningLine: [0, 1, 2] }]);
  });

  // Ported from prototype scenario "Исчезновение отменяет ожидаемую победу": X's 4th mark
  // vanishes its own oldest mark from the about-to-complete top row *before* the win check,
  // so the expected win never fires — the win only lands later on a different line.
  it("removes the mover's oldest mark before the win check, cancelling an expected win", () => {
    let state = createMatch("X");
    ({ state } = place(state, 0)); // X top-left
    ({ state } = place(state, 4)); // O center
    ({ state } = place(state, 1)); // X top-mid
    ({ state } = place(state, 5)); // O mid-right
    ({ state } = place(state, 3)); // X mid-left (X now has 3: 0,1,3)
    ({ state } = place(state, 7)); // O bottom-mid

    const beforeVanish = state;
    const { state: afterVanish, events: vanishEvents } = place(beforeVanish, 2); // X top-right, 4th mark

    // Top row (0,1,2) would be a win, but placing the 4th mark removes X's oldest (cell 0) first.
    expect(afterVanish.status).toBe("in-progress");
    expect(afterVanish.board[0]).toBeNull();
    expect(afterVanish.lastRemovedCell).toBe(0);
    expect(vanishEvents).toEqual([{ type: "MARK_VANISHED", symbol: "X", cell: 0 }]);
  });

  it("rejects placing on an occupied cell and leaves state unchanged", () => {
    const state = createMatch("X");
    const { state: afterMove } = place(state, 4); // X center

    const { state: rejectedState, events } = place(afterMove, 4); // O tries same cell

    expect(rejectedState).toEqual(afterMove);
    expect(events).toEqual([{ type: "MOVE_REJECTED", reason: "cell-occupied" }]);
  });

  it("ends the match by forfeit and blocks rematch afterward", () => {
    let state = createMatch("X");
    ({ state } = place(state, 4)); // X center
    ({ state } = place(state, 0)); // O top-left

    const { state: forfeited, events: forfeitEvents } = reduceMatch(state, {
      type: "FORFEIT",
      bySymbol: "X",
    });

    expect(forfeited.status).toBe("forfeited");
    expect(forfeited.winner).toBe("O");
    expect(forfeitEvents).toEqual([{ type: "MATCH_FORFEITED", bySymbol: "X", winner: "O" }]);

    const { events: rematchEvents } = reduceMatch(forfeited, { type: "REMATCH" });
    expect(rematchEvents).toEqual([{ type: "REMATCH_REJECTED", reason: "forfeited-match" }]);
  });

  it("rejects a move once the match is already over", () => {
    let state = createMatch("X");
    ({ state } = place(state, 0));
    ({ state } = place(state, 3));
    ({ state } = place(state, 1));
    ({ state } = place(state, 4));
    ({ state } = place(state, 2)); // X wins top row

    const { state: after, events } = place(state, 5);
    expect(after).toEqual(state);
    expect(events).toEqual([{ type: "MOVE_REJECTED", reason: "match-over" }]);
  });

  // Ported from prototype scenario "Реванш меняет стороны".
  it("swaps seats on rematch after a normal win, X moving first again", () => {
    let state = createMatch("X"); // seatA = X, seatB = O
    ({ state } = place(state, 0)); // X top-left
    ({ state } = place(state, 3)); // O mid-left
    ({ state } = place(state, 1)); // X top-mid
    ({ state } = place(state, 4)); // O center
    ({ state } = place(state, 2)); // X wins

    expect(state.status).toBe("won");

    const { state: rematch, events } = reduceMatch(state, { type: "REMATCH" });

    expect(rematch.seatA).toBe("O");
    expect(rematch.seatB).toBe("X");
    expect(rematch.status).toBe("in-progress");
    expect(rematch.currentPlayer).toBe("X");
    expect(rematch.board.every((c) => c === null)).toBe(true);
    expect(events).toEqual([{ type: "MATCH_STARTED", seatA: "O", seatB: "X" }]);
  });

  it("rejects rematch while the match is still in progress", () => {
    const state = createMatch("X");
    const { events } = reduceMatch(state, { type: "REMATCH" });
    expect(events).toEqual([{ type: "REMATCH_REJECTED", reason: "match-in-progress" }]);
  });

  it("caps each player at 3 marks, dropping the oldest in FIFO order", () => {
    let state = createMatch("X");
    // X plays 0,1,3 (3 marks); O plays 4,5,7,8 interleaved to avoid winning/losing early.
    const moves: [number, number][] = [
      [0, 4],
      [1, 5],
      [3, 7],
    ];
    for (const [x, o] of moves) {
      ({ state } = place(state, x));
      ({ state } = place(state, o));
    }
    expect(state.marks.X).toEqual([0, 1, 3]);
    expect(state.marks.O).toEqual([4, 5, 7]);

    const { state: afterFourth } = place(state, 6); // X's 4th mark -> drops cell 0
    expect(afterFourth.marks.X).toEqual([1, 3, 6]);
    expect(afterFourth.board[0]).toBeNull();
  });
});
