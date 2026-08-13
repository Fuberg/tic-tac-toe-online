// Issue #4: the board for a Match against a bot. All vanishing-marks/turn-order/win rules
// live in the domain reducer (src/server/domain/match.ts via lobby.ts) — this component only
// renders the latest match:update snapshot and emits match:place on cell clicks. Forfeit,
// rematch, and leaving back to the lobby are issue #5's concern; the action shapes already
// exist server-side but this view doesn't expose them yet.
"use client";

import { DIFFICULTY_LABEL, type BotDifficulty } from "./bot-labels";
import { useSocket } from "./socket-provider";
import styles from "./match.module.css";

type Mark = "X" | "O";
type Cell = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type MatchStatus = "in-progress" | "won" | "forfeited";
type SeatKey = "seatA" | "seatB";

type ParticipantRef = { type: "player"; playerId: string } | { type: "bot"; difficulty: BotDifficulty };

interface MatchState {
  board: (Mark | null)[];
  currentPlayer: Mark;
  seatA: Mark;
  seatB: Mark;
  status: MatchStatus;
  winner: Mark | null;
  winningLine: Cell[] | null;
}

export interface MatchSnapshot {
  id: string;
  seatA: ParticipantRef;
  seatB: ParticipantRef;
  match: MatchState;
  rematchRequestedBy: SeatKey | null;
}

function opponentLabel(opponent: ParticipantRef | null): string {
  if (!opponent) return "Соперник";
  return opponent.type === "bot" ? `Бот (${DIFFICULTY_LABEL[opponent.difficulty]})` : "Соперник";
}

export function Match({ snapshot }: { snapshot: MatchSnapshot }) {
  const { socket } = useSocket();

  const localSeat: SeatKey | null =
    snapshot.seatA.type === "player" && snapshot.seatA.playerId === socket.id
      ? "seatA"
      : snapshot.seatB.type === "player" && snapshot.seatB.playerId === socket.id
        ? "seatB"
        : null;
  const localMark = localSeat ? snapshot.match[localSeat] : null;
  const opponent = localSeat ? snapshot[localSeat === "seatA" ? "seatB" : "seatA"] : null;

  const isMyTurn =
    localMark != null && snapshot.match.status === "in-progress" && snapshot.match.currentPlayer === localMark;

  function handleCellClick(cell: Cell) {
    if (!isMyTurn || snapshot.match.board[cell] != null) return;
    socket.emit("match:place", { matchId: snapshot.id, cell });
  }

  let statusText: string;
  if (snapshot.match.status === "won") {
    statusText =
      localMark == null
        ? `Победили: ${snapshot.match.winner}`
        : snapshot.match.winner === localMark
          ? "Вы победили!"
          : "Вы проиграли";
  } else if (snapshot.match.status === "forfeited") {
    statusText = "Матч завершён";
  } else {
    statusText = isMyTurn ? "Ваш ход" : "Ход соперника";
  }

  return (
    <section className={styles.match}>
      <div className={styles.header}>
        <h2>Матч против: {opponentLabel(opponent)}</h2>
        <p className={styles.status}>{statusText}</p>
      </div>
      <div className={styles.board}>
        {snapshot.match.board.map((mark, index) => {
          const cell = index as Cell;
          const isWinningCell = snapshot.match.winningLine?.includes(cell) ?? false;
          return (
            <button
              key={cell}
              type="button"
              className={styles.cell}
              data-mark={mark}
              data-winning={isWinningCell || undefined}
              onClick={() => handleCellClick(cell)}
              disabled={!isMyTurn || mark != null}
              aria-label={`Клетка ${cell + 1}`}
            >
              {mark}
            </button>
          );
        })}
      </div>
    </section>
  );
}
