/** Read-only app-server handshake + saved-session discovery; never starts a turn. */
import { config } from "dotenv";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "../src/acp/client.js";
import { SessionStore } from "../src/sessions/store.js";
import { readHistory } from "../src/sessions/history.js";
import { setLogLevel } from "../src/logger.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(root, ".env") });
setLogLevel("error");
const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const client = new AcpClient({
  codexCliPath: process.env.CODEX_CLI_PATH || (process.platform === "win32" ? "codex.cmd" : "codex"),
  workspace: process.env.CODEX_WORKSPACE || root,
  codexHome,
  trustAllTools: false,
  autoRestart: false,
  requestTimeoutMs: 15_000,
});
try {
  await client.start();
  const store = new SessionStore(join(codexHome, "sessions"));
  const target = process.argv[2];
  console.log(JSON.stringify({
    agent: client.agentInfo,
    savedSessions: store.list(100_000).length,
    targetVisible: target ? Boolean(store.get(target)) : undefined,
    historyEntries: target && store.get(target) ? readHistory(store.jsonlPath(target), 100_000).length : undefined,
    runningStateAvailable: false,
  }));
} finally {
  client.stop();
}
