// Issue #2: the client establishes a Socket.IO connection to the same-origin custom
// server (server.ts) and surfaces connected/disconnected status. No lobby/nickname UI
// here yet — that's separate work per issue #1's Out of Scope.
"use client";

import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import styles from "./connection-status.module.css";

type SocketStatus = "connecting" | "connected" | "disconnected";

const STATUS_LABEL: Record<SocketStatus, string> = {
  connecting: "Подключение…",
  connected: "Подключено",
  disconnected: "Нет соединения",
};

export function ConnectionStatus() {
  const [status, setStatus] = useState<SocketStatus>("connecting");

  useEffect(() => {
    const socket = io();

    const handleConnect = () => setStatus("connected");
    const handleDisconnect = () => setStatus("disconnected");

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleDisconnect);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleDisconnect);
      socket.disconnect();
    };
  }, []);

  return (
    <div className={styles.status} data-status={status}>
      <span className={styles.dot} />
      {STATUS_LABEL[status]}
    </div>
  );
}
