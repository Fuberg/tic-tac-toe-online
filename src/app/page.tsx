import { ConnectionStatus } from "./connection-status";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1>Tic-Tac-Toe Online</h1>
        <ConnectionStatus />
      </main>
    </div>
  );
}
