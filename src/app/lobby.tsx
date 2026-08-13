// Issue #3: nickname entry -> lobby with a live online-players list -> explicit leave.
// All the actual join/leave/lobby-timeout logic lives in the domain reducer
// (src/server/domain/lobby.ts) behind the socket events used here — this component is a thin
// view over lobby:join / lobby:leave / lobby:update / lobby:visibility.
"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useSocket } from "./socket-provider";
import styles from "./lobby.module.css";

interface LobbyPlayer {
  id: string;
  nickname: string;
  status: "available" | "busy" | "in-game" | null;
}

interface LobbySnapshot {
  players: LobbyPlayer[];
}

type AckResult = { ok: true } | { ok: false; reason: string };

const STATUS_LABEL: Record<NonNullable<LobbyPlayer["status"]>, string> = {
  available: "Свободен",
  busy: "Занят",
  "in-game": "В игре",
};

export function Lobby() {
  const { socket, status: connectionStatus } = useSocket();
  const [joined, setJoined] = useState(false);
  const [joining, setJoining] = useState(false);
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [players, setPlayers] = useState<LobbyPlayer[]>([]);

  useEffect(() => {
    const handleLobbyUpdate = (snapshot: LobbySnapshot) => setPlayers(snapshot.players);
    // The server broadcasts this before a graceful shutdown/deploy and drops every connection
    // right after — reflect that by returning to the nickname screen instead of showing a
    // lobby that's about to silently stop updating.
    const handleShutdown = () => {
      setJoined(false);
      setError("Сервер обновляется — попробуйте зайти снова через минуту.");
    };

    socket.on("lobby:update", handleLobbyUpdate);
    socket.on("server:shutdown", handleShutdown);
    return () => {
      socket.off("lobby:update", handleLobbyUpdate);
      socket.off("server:shutdown", handleShutdown);
    };
  }, [socket]);

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
      if (result.ok) {
        setJoined(true);
      } else {
        setError("Не удалось войти в лобби, попробуйте другой никнейм");
      }
    });
  }

  function handleLeave() {
    socket.emit("lobby:leave", {}, () => {
      setJoined(false);
      setPlayers([]);
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
        {error && <p className={styles.error}>{error}</p>}
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
      {error && <p className={styles.error}>{error}</p>}
      <ul className={styles.players}>
        {players.map((player) => (
          <li key={player.id} className={styles.player}>
            <span className={styles.playerName}>
              {player.nickname}
              {player.id === socket.id && <span className={styles.you}> (вы)</span>}
            </span>
            {player.status && (
              <span className={styles.playerStatus} data-status={player.status}>
                {STATUS_LABEL[player.status]}
              </span>
            )}
          </li>
        ))}
        {players.every((p) => p.id === socket.id) && (
          <li className={styles.empty}>Больше в лобби никого нет</li>
        )}
      </ul>
    </section>
  );
}
