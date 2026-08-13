import { ConnectionStatus } from "./connection-status";
import { Game } from "./game";
import { SocketProvider } from "./socket-provider";
import styles from "./page.module.css";

export default function Home() {
  return (
    <SocketProvider>
      <div className={styles.page}>
        <main className={styles.main}>
          <div className={styles.top}>
            <h1>Tic-Tac-Toe Online</h1>
            <ConnectionStatus />
          </div>
          <Game />
        </main>
      </div>
    </SocketProvider>
  );
}
