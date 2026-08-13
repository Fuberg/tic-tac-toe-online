// Issue #2: surfaces the shared Socket.IO connection's status. The connection itself now
// lives in SocketProvider (issue #3) so lobby components can use the same socket.
"use client";

import { useSocket, type SocketStatus } from "./socket-provider";
import styles from "./connection-status.module.css";

const STATUS_LABEL: Record<SocketStatus, string> = {
  connecting: "Подключение…",
  connected: "Подключено",
  disconnected: "Нет соединения",
};

export function ConnectionStatus() {
  const { status } = useSocket();

  return (
    <div className={styles.status} data-status={status} role="status" aria-live="polite" aria-atomic="true">
      <span className={styles.dot} />
      {STATUS_LABEL[status]}
    </div>
  );
}
