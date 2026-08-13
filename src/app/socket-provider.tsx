// Single Socket.IO connection shared by every client component (lobby UI, connection status)
// via context, instead of each component opening its own — matches issue #2's "one same-origin
// connection" intent, just no longer confined to a single component.
"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { io, type Socket } from "socket.io-client";

export type SocketStatus = "connecting" | "connected" | "disconnected";

interface SocketContextValue {
  socket: Socket;
  status: SocketStatus;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const [socket] = useState(() => io());
  const [status, setStatus] = useState<SocketStatus>("connecting");

  useEffect(() => {
    const handleConnect = () => setStatus("connected");
    const handleDisconnect = () => setStatus("disconnected");

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleDisconnect);
    // Dev-only React Strict Mode mounts this effect twice (mount -> cleanup -> mount) against
    // the same socket instance from useState above. The cleanup's disconnect() below is a
    // manual disconnect, which socket.io-client never auto-retries — without this explicit
    // reconnect on (re)mount, the phantom Strict Mode cycle would leave the socket permanently
    // disconnected in dev.
    socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleDisconnect);
      socket.disconnect();
    };
  }, [socket]);

  return <SocketContext.Provider value={{ socket, status }}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  const value = useContext(SocketContext);
  if (!value) throw new Error("useSocket must be used within a SocketProvider");
  return value;
}
