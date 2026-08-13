// Issue #3: nickname entry -> lobby with a live online-players list -> explicit leave.
// Issue #4: also lists the fixed set of bots and starts a Match against one on click.
// Issue #7: challenging another online player -> shared countdown -> accept/decline.
// All the actual join/leave/lobby-timeout/match-start/challenge logic lives in the domain
// reducer (src/server/domain/lobby.ts) behind the socket events used here — this component is
// a thin view over lobby:join / lobby:leave / lobby:update / lobby:visibility / bot:start /
// challenge:send / challenge:accept / challenge:decline / challenge:pending / challenge:resolved.
"use client";

import { useEffect, useState, type FormEvent } from "react";
import { DIFFICULTY_LABEL, type BotDifficulty } from "./bot-labels";
import { useSocket } from "./socket-provider";
import styles from "./lobby.module.css";

export interface LobbyPlayer {
  id: string;
  nickname: string;
  status: "available" | "busy" | "in-game" | null;
}

export interface LobbyBot {
  id: string;
  difficulty: BotDifficulty;
}

export interface LobbySnapshot {
  players: LobbyPlayer[];
  bots: LobbyBot[];
}

// Mirrors server/domain/lobby.types.ts's PendingChallenge — kept as a local shape (like
// LobbySnapshot above) rather than imported, since the client only ever sees it as a socket
// payload, never the server module itself.
interface PendingChallenge {
  id: string;
  fromPlayerId: string;
  toPlayerId: string;
  deadline: number;
}

type ChallengeOutcome = "accepted" | "declined" | "expired" | "challenger-left" | "target-left";

type AckResult = { ok: true } | { ok: false; reason: string };

const STATUS_LABEL: Record<NonNullable<LobbyPlayer["status"]>, string> = {
  available: "Свободен",
  busy: "Занят",
  "in-game": "В игре",
};

// No label for "accepted" — that outcome is reflected by the view switching to the Match
// board (game.tsx reacts to match:update), not by a notice here.
const CHALLENGE_OUTCOME_LABEL: Partial<Record<ChallengeOutcome, string>> = {
  declined: "Вызов отклонён",
  expired: "Время вызова истекло",
  "challenger-left": "Игрок, отправивший вызов, покинул лобби",
  "target-left": "Игрок, которому вы отправили вызов, покинул лобби",
};

// Issue #8: `players`/`bots` come from Game, not from a subscription local to this component.
// Game keeps its own lobby:update listener alive for the app's whole lifetime — including
// while a Match is mounted and this component isn't — so it's the one place guaranteed to
// have received the lobby:update the server sends the instant a match ends (the server still
// considers a player a lobby member through a match; leaving a match isn't leaving the lobby).
// A listener/local-state pair scoped to this component would either miss that broadcast
// entirely (not mounted yet when it arrives) or, if seeded once from an "initial" snapshot at
// mount, freeze on a stale copy forever if no later lobby event happens to correct it — both
// tried and both failed manual testing. Deriving `joined` from `players` on every render (never
// storing it as separate local state) sidesteps that: it's never stale by more than a render.
export function Lobby({ snapshot }: { snapshot: LobbySnapshot }) {
  const { socket, status: connectionStatus } = useSocket();
  const { players, bots } = snapshot;
  const joined = players.some((p) => p.id === socket.id);
  const [joining, setJoining] = useState(false);
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [startingBot, setStartingBot] = useState<BotDifficulty | null>(null);
  const [pendingChallenge, setPendingChallenge] = useState<PendingChallenge | null>(null);
  const [challengeNotice, setChallengeNotice] = useState<string | null>(null);
  const [sendingChallengeTo, setSendingChallengeTo] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Leaving the lobby (explicitly or via a server shutdown) always clears out whatever
  // challenge state was showing — pulled out since both exit paths below need it together.
  function clearChallengeUI() {
    setPendingChallenge(null);
    setChallengeNotice(null);
  }

  useEffect(() => {
    // The server broadcasts server:shutdown before a graceful shutdown/deploy and drops every
    // connection right after. Game reacts to the same event by clearing its lobby snapshot
    // (flipping `joined` above to false via the empty `players` prop) — this handler only owns
    // the presentational side: showing why the nickname screen reappeared.
    const handleShutdown = () => {
      setError("Сервер обновляется — попробуйте зайти снова через минуту.");
      clearChallengeUI();
    };

    socket.on("server:shutdown", handleShutdown);
    return () => {
      socket.off("server:shutdown", handleShutdown);
    };
  }, [socket]);

  // Issue #7: a challenge sent to or received from another player. challenge:pending arrives
  // for both parties the moment SEND_CHALLENGE succeeds; challenge:resolved arrives once for
  // whichever of accept/decline/expire/cancel ends it. Outcome "accepted" needs no notice here
  // — the view switches to the Match board on its own once match:update arrives (see game.tsx).
  useEffect(() => {
    const handleChallengePending = (challenge: PendingChallenge) => {
      setPendingChallenge(challenge);
      setChallengeNotice(null);
    };
    const handleChallengeResolved = (payload: { challengeId: string; outcome: ChallengeOutcome }) => {
      setPendingChallenge((current) => (current?.id === payload.challengeId ? null : current));
      if (payload.outcome !== "accepted") {
        setChallengeNotice(CHALLENGE_OUTCOME_LABEL[payload.outcome] ?? null);
      }
    };

    socket.on("challenge:pending", handleChallengePending);
    socket.on("challenge:resolved", handleChallengeResolved);
    return () => {
      socket.off("challenge:pending", handleChallengePending);
      socket.off("challenge:resolved", handleChallengeResolved);
    };
  }, [socket]);

  // Ticks the shared countdown while a challenge is pending — only runs while one exists, and
  // keyed on its id (not the object itself) so a re-render with the same challenge doesn't
  // restart the interval.
  const pendingChallengeId = pendingChallenge?.id ?? null;
  useEffect(() => {
    if (!pendingChallengeId) return;
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, [pendingChallengeId]);

  // Lobby-timeout (CONTEXT.md): a hidden-but-not-closed tab is removed from the lobby after a
  // server-side delay. Only relevant once actually in the lobby, so it doesn't fire before
  // join — but it does report the current state immediately on join (not just on the next
  // change), in case the tab was already hidden the moment the player joined.
  useEffect(() => {
    if (!joined) return;
    const handleVisibilityChange = () => socket.emit("lobby:visibility", { hidden: document.hidden });
    handleVisibilityChange();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [joined, socket]);

  function handleJoin(event: FormEvent) {
    event.preventDefault();
    const trimmed = nickname.trim();
    if (!trimmed) {
      setError("Введите никнейм");
      return;
    }

    setJoining(true);
    setError(null);
    socket.emit("lobby:join", { nickname: trimmed }, (result: AckResult) => {
      setJoining(false);
      if (!result.ok) setError("Не удалось войти в лобби, попробуйте другой никнейм");
    });
  }

  function handleLeave() {
    socket.emit("lobby:leave", {}, () => clearChallengeUI());
  }

  function handleSendChallenge(toPlayerId: string) {
    setSendingChallengeTo(toPlayerId);
    setChallengeNotice(null);
    setError(null);
    socket.emit("challenge:send", { toPlayerId }, (result: AckResult) => {
      setSendingChallengeTo(null);
      if (!result.ok) setError("Не удалось отправить вызов, попробуйте ещё раз");
    });
  }

  function handleAcceptChallenge() {
    if (!pendingChallenge) return;
    setError(null);
    socket.emit("challenge:accept", { challengeId: pendingChallenge.id }, (result: AckResult) => {
      if (!result.ok) setError("Не удалось принять вызов, попробуйте ещё раз");
    });
  }

  function handleDeclineChallenge() {
    if (!pendingChallenge) return;
    setError(null);
    socket.emit("challenge:decline", { challengeId: pendingChallenge.id }, (result: AckResult) => {
      if (!result.ok) setError("Не удалось отклонить вызов, попробуйте ещё раз");
    });
  }

  // Issue #4: clicking a bot starts a Match immediately, no Challenge step. The lobby view
  // doesn't need to react to success itself — Game switches to the board once match:update
  // arrives on the shared socket.
  function handleStartBot(difficulty: BotDifficulty) {
    setStartingBot(difficulty);
    setError(null);
    socket.emit("bot:start", { difficulty }, (result: AckResult) => {
      setStartingBot(null);
      if (!result.ok) setError("Не удалось начать матч с ботом, попробуйте ещё раз");
    });
  }

  if (!joined) {
    return (
      <form className={styles.joinForm} onSubmit={handleJoin}>
        <label htmlFor="nickname">Никнейм</label>
        <input
          id="nickname"
          name="nickname"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
          maxLength={32}
          placeholder="Ваш никнейм"
          autoComplete="off"
          disabled={connectionStatus !== "connected" || joining}
          autoFocus
        />
        <button type="submit" disabled={connectionStatus !== "connected" || joining}>
          Войти в лобби
        </button>
        {error && (
          <p className={styles.error} role="alert" aria-atomic="true">
            {error}
          </p>
        )}
      </form>
    );
  }

  return (
    <section className={styles.lobby}>
      <div className={styles.lobbyHeader}>
        <h2>Лобби</h2>
        <button type="button" onClick={handleLeave}>
          Выйти
        </button>
      </div>
      {error && (
        <p className={styles.error} role="alert" aria-atomic="true">
          {error}
        </p>
      )}
      {challengeNotice && (
        <p className={styles.notice} role="status" aria-live="polite" aria-atomic="true">
          {challengeNotice}
        </p>
      )}
      {pendingChallenge && (
        <ChallengePanel
          challenge={pendingChallenge}
          selfId={socket.id}
          players={players}
          remainingSeconds={Math.max(0, Math.ceil((pendingChallenge.deadline - now) / 1000))}
          onAccept={handleAcceptChallenge}
          onDecline={handleDeclineChallenge}
        />
      )}
      <ul className={styles.players}>
        {players.map((player) => (
          <li key={player.id} className={styles.player}>
            <span className={styles.playerName}>
              {player.nickname}
              {player.id === socket.id && <span className={styles.you}> (вы)</span>}
            </span>
            <span className={styles.playerActions}>
              {player.status && (
                <span className={styles.playerStatus} data-status={player.status}>
                  {STATUS_LABEL[player.status]}
                </span>
              )}
              {player.id !== socket.id && player.status === "available" && (
                <button
                  type="button"
                  className={styles.challengeButton}
                  onClick={() => handleSendChallenge(player.id)}
                  disabled={pendingChallenge !== null || sendingChallengeTo !== null}
                >
                  Вызвать
                </button>
              )}
            </span>
          </li>
        ))}
        {players.every((p) => p.id === socket.id) && (
          <li className={styles.empty}>Больше в лобби никого нет</li>
        )}
      </ul>
      <div className={styles.bots}>
        <h3>Играть с ботом</h3>
        <ul className={styles.botList}>
          {bots.map((bot) => (
            <li key={bot.id}>
              <button
                type="button"
                onClick={() => handleStartBot(bot.difficulty)}
                disabled={startingBot !== null || pendingChallenge !== null}
              >
                {DIFFICULTY_LABEL[bot.difficulty]}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function ChallengePanel({
  challenge,
  selfId,
  players,
  remainingSeconds,
  onAccept,
  onDecline,
}: {
  challenge: PendingChallenge;
  selfId: string | undefined;
  players: LobbyPlayer[];
  remainingSeconds: number;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const incoming = challenge.toPlayerId === selfId;
  const otherPlayerId = incoming ? challenge.fromPlayerId : challenge.toPlayerId;
  const otherNickname = players.find((p) => p.id === otherPlayerId)?.nickname ?? "Игрок";

  return (
    <div className={styles.challengePanel}>
      {incoming ? (
        <>
          <p>
            <strong>{otherNickname}</strong> вызывает вас на матч!
          </p>
          <p className={styles.challengeTimer}>Осталось: {remainingSeconds}с</p>
          <div className={styles.challengeActions}>
            <button type="button" onClick={onAccept}>
              Принять
            </button>
            <button type="button" className={styles.declineButton} onClick={onDecline}>
              Отклонить
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Вызов отправлен игроку <strong>{otherNickname}</strong>. Ожидание ответа…
          </p>
          <p className={styles.challengeTimer}>Осталось: {remainingSeconds}с</p>
        </>
      )}
    </div>
  );
}
