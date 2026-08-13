// Issue #4: the board for a Match against a bot. All vanishing-marks/turn-order/win rules
// live in the domain reducer (src/server/domain/match.ts via lobby.ts) — this component only
// renders the latest match:update snapshot and emits match:place on cell clicks.
// Issue #5: the result-screen actions (rematch/leave). The action shapes and their rules
// (forfeit blocks rematch, rematch needs mutual agreement and swaps seats, leaving mid-request
// sends both players back to the lobby) already live server-side — this view just exposes them.
"use client";

import { useState } from "react";
import { DIFFICULTY_LABEL, type BotDifficulty } from "./bot-labels";
import { useSocket } from "./socket-provider";
import styles from "./match.module.css";

type AckResult = { ok: true } | { ok: false; reason: string };

type Mark = "X" | "O";
type Cell = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type MatchStatus = "in-progress" | "won" | "forfeited";
type SeatKey = "seatA" | "seatB";

type ParticipantRef = { type: "player"; playerId: string } | { type: "bot"; difficulty: BotDifficulty };

interface MatchState {
  board: (Mark | null)[];
  marks: Record<Mark, Cell[]>;
  currentPlayer: Mark;
  seatA: Mark;
  seatB: Mark;
  status: MatchStatus;
  winner: Mark | null;
  winningLine: Cell[] | null;
  lastRemovedCell: Cell | null;
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

// Issue #11: label a seat with "Вы" only for the local seat — with no local seat
// (e.g. observer/disconnected view) this falls back to opponentLabel for both seats, so
// both marks are still shown without ever claiming one as "yours".
function seatLabel(participant: ParticipantRef, isLocal: boolean): string {
  return isLocal ? "Вы" : opponentLabel(participant);
}

export function Match({ snapshot }: { snapshot: MatchSnapshot }) {
  const { socket } = useSocket();
  const [actionPending, setActionPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localSeat: SeatKey | null =
    snapshot.seatA.type === "player" && snapshot.seatA.playerId === socket.id
      ? "seatA"
      : snapshot.seatB.type === "player" && snapshot.seatB.playerId === socket.id
        ? "seatB"
        : null;
  const localMark = localSeat ? snapshot.match[localSeat] : null;
  const opponent = localSeat ? snapshot[localSeat === "seatA" ? "seatB" : "seatA"] : null;

  // Issue #11: marks swap on rematch, so re-derive both seats' labels/marks from the
  // snapshot every render instead of caching them anywhere.
  const seatALabel = seatLabel(snapshot.seatA, localSeat === "seatA");
  const seatBLabel = seatLabel(snapshot.seatB, localSeat === "seatB");

  const isMyTurn =
    localMark != null && snapshot.match.status === "in-progress" && snapshot.match.currentPlayer === localMark;

  // Issue #10: blur the cell up front instead of leaving it focused. Otherwise the
  // match:update snapshot that follows sets disabled={true} on this same button, and per
  // the HTML "unfocus steps" the browser force-removes focus from a disabled element —
  // animated by .cell's transition, which reads as the board visibly jumping. See #9 for
  // the full diagnosis.
  function handleCellClick(cell: Cell, event: React.MouseEvent<HTMLButtonElement>) {
    if (!isMyTurn || snapshot.match.board[cell] != null) return;
    event.currentTarget.blur();
    setError(null);
    socket.emit("match:place", { matchId: snapshot.id, cell }, (result: AckResult) => {
      if (!result.ok) setError("Не удалось сделать ход, попробуйте ещё раз");
    });
  }

  function handleRequestRematch() {
    setActionPending(true);
    setError(null);
    socket.emit("match:requestRematch", { matchId: snapshot.id }, (result: AckResult) => {
      setActionPending(false);
      if (!result.ok) setError("Не удалось запросить реванш, попробуйте ещё раз");
    });
  }

  // No client-side cleanup needed after a successful leave: the server's own match:update
  // (with a null payload once the match entry is gone) already flips the parent back to
  // <Lobby/> for both participants — see game-server.ts's LEAVE_MATCH handling.
  function handleLeave() {
    setActionPending(true);
    setError(null);
    socket.emit("match:leave", { matchId: snapshot.id }, (result: AckResult) => {
      if (!result.ok) {
        setActionPending(false);
        setError("Не удалось выйти в лобби, попробуйте ещё раз");
      }
    });
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
    statusText =
      localMark == null
        ? "Матч завершён по таймауту"
        : snapshot.match.winner === localMark
          ? "Соперник отключился — вы победили"
          : "Вы проиграли по таймауту";
  } else {
    statusText = isMyTurn ? "Ваш ход" : "Ход соперника";
  }

  // Issue #1 user story: "сколько у меня фишек на поле, чтобы планировать следующий ход" —
  // with at most 3 marks per side, knowing the count tells you whether your next placement
  // will vanish your oldest one.
  const myMarkCount = localMark ? snapshot.match.marks[localMark].length : null;

  // CONTEXT.md Match end/Rematch: rematch is only offered after a normal win, never after a
  // timeout/disconnect forfeit; while a request is pending, the requester waits and the other
  // seat sees an "accept" affordance instead of a fresh request.
  const iRequestedRematch = localSeat != null && snapshot.rematchRequestedBy === localSeat;
  const opponentRequestedRematch =
    localSeat != null && snapshot.rematchRequestedBy != null && snapshot.rematchRequestedBy !== localSeat;
  const rematchLabel = iRequestedRematch
    ? "Ожидание соперника…"
    : opponentRequestedRematch
      ? "Принять реванш"
      : "Реванш";

  return (
    <section className={styles.match}>
      <div className={styles.header}>
        <h2>Матч против: {opponentLabel(opponent)}</h2>
        <p className={styles.status}>{statusText}</p>
        <p className={styles.marks}>
          {seatALabel}: {snapshot.match.seatA} · {seatBLabel}: {snapshot.match.seatB}
        </p>
        {myMarkCount != null && <p className={styles.markCount}>Ваших фишек на поле: {myMarkCount}/3</p>}
      </div>
      <div className={styles.board}>
        {snapshot.match.board.map((mark, index) => {
          const cell = index as Cell;
          const isWinningCell = snapshot.match.winningLine?.includes(cell) ?? false;
          // Issue #1 user story: "ясно видеть момент, когда моя фишка только что исчезла" —
          // lastRemovedCell is the cell PLACE just vacated (null once a later move doesn't
          // remove anything), so this only ever marks the most recent vanish, never a stale one.
          const justVanished = snapshot.match.lastRemovedCell === cell;
          return (
            <button
              key={cell}
              type="button"
              className={styles.cell}
              data-mark={mark}
              data-winning={isWinningCell || undefined}
              data-just-vanished={justVanished || undefined}
              onClick={(event) => handleCellClick(cell, event)}
              disabled={!isMyTurn || mark != null}
              aria-label={`Клетка ${cell + 1}`}
            >
              {mark}
            </button>
          );
        })}
      </div>
      {snapshot.match.status !== "in-progress" && (
        <div className={styles.resultActions}>
          {snapshot.match.status === "won" && (
            <button
              type="button"
              onClick={handleRequestRematch}
              disabled={actionPending || iRequestedRematch}
            >
              {rematchLabel}
            </button>
          )}
          <button type="button" className={styles.leaveButton} onClick={handleLeave} disabled={actionPending}>
            Выйти в лобби
          </button>
        </div>
      )}
      {error && (
        <p className={styles.error} role="alert" aria-atomic="true">
          {error}
        </p>
      )}
    </section>
  );
}
