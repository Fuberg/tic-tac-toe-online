// Issue #4: switches between the lobby and the match board based on match:update — the
// server sends one the moment a Match starts (bot or otherwise) and again on reconnect if the
// player already has one, so this is the single source of truth for which view to show.
//
// Issue #8: also keeps its own lobby:update subscription for as long as Game itself is
// mounted — i.e. across the whole session, through Match screens where <Lobby/> isn't mounted
// at all. The server keeps a player as a lobby member through a Match (leaving a match isn't
// leaving the lobby), and broadcasts lobby:update for both transitions; a listener that only
// lived inside <Lobby/> would miss the one sent the instant a match ends, since that's exactly
// when <Lobby/> is (re)mounting. Passed down as live props (not just an initial seed) so a
// second lobby:update that lands in the same tick as the match-end transition still reaches
// Lobby — an initial-only seed, tried first, went stale forever if nothing later corrected it.
"use client";

import { useEffect, useState } from "react";
import { useSocket } from "./socket-provider";
import { Lobby, type LobbySnapshot } from "./lobby";
import { Match, type MatchSnapshot } from "./match";

const EMPTY_LOBBY_SNAPSHOT: LobbySnapshot = { players: [], bots: [] };

export function Game() {
  const { socket } = useSocket();
  const [match, setMatch] = useState<MatchSnapshot | null>(null);
  const [lobbySnapshot, setLobbySnapshot] = useState<LobbySnapshot>(EMPTY_LOBBY_SNAPSHOT);

  useEffect(() => {
    const handleMatchUpdate = (snapshot: MatchSnapshot) => setMatch(snapshot);
    const handleLobbyUpdate = (snapshot: LobbySnapshot) => setLobbySnapshot(snapshot);
    // Mirrors the server dropping every connection right after this broadcast (see
    // game-server.ts's shutdown()) — nothing will correct a stale snapshot afterwards, so clear
    // it eagerly instead of leaving Lobby to derive `joined: true` from membership data that's
    // about to stop being true.
    const handleShutdown = () => setLobbySnapshot(EMPTY_LOBBY_SNAPSHOT);
    socket.on("match:update", handleMatchUpdate);
    socket.on("lobby:update", handleLobbyUpdate);
    socket.on("server:shutdown", handleShutdown);
    return () => {
      socket.off("match:update", handleMatchUpdate);
      socket.off("lobby:update", handleLobbyUpdate);
      socket.off("server:shutdown", handleShutdown);
    };
  }, [socket]);

  if (match) return <Match snapshot={match} />;
  return <Lobby snapshot={lobbySnapshot} />;
}
