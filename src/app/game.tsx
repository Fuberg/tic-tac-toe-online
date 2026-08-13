// Issue #4: switches between the lobby and the match board based on match:update — the
// server sends one the moment a Match starts (bot or otherwise) and again on reconnect if the
// player already has one, so this is the single source of truth for which view to show.
"use client";

import { useEffect, useState } from "react";
import { useSocket } from "./socket-provider";
import { Lobby } from "./lobby";
import { Match, type MatchSnapshot } from "./match";

export function Game() {
  const { socket } = useSocket();
  const [match, setMatch] = useState<MatchSnapshot | null>(null);

  useEffect(() => {
    const handleMatchUpdate = (snapshot: MatchSnapshot) => setMatch(snapshot);
    socket.on("match:update", handleMatchUpdate);
    return () => {
      socket.off("match:update", handleMatchUpdate);
    };
  }, [socket]);

  if (match) return <Match snapshot={match} />;
  return <Lobby />;
}
