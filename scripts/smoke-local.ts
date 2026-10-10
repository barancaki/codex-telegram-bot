/** Read-only app-server handshake + saved-session discovery; never starts a turn. */
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { AcpClient } from "../src/acp/client.js";
import { SessionStore } from "../src/sessions/store.js";
import { readHistory } from "../src/sessions/history.js";
import { setLogLevel } from "../src/logger.js";

setLogLevel("error");
const cfg = loadConfig();
const codexHome = cfg.codexHome;
const client = new AcpClient({
  codexCliPath: cfg.codexCliPath,
  workspace: cfg.workspace,
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
    codexCliPath: cfg.codexCliPath,
    modelSource: "live model/list",
    configuredModel: client.currentModelId,
    configuredEffort: client.defaultReasoningEffort,
    models: client.availableModels,
    modelRefreshFailed: Boolean(client.modelInventoryError),
    savedSessions: store.list(100_000).length,
    targetVisible: target ? Boolean(store.get(target)) : undefined,
    historyEntries: target && store.get(target) ? readHistory(store.jsonlPath(target), 100_000).length : undefined,
    runningStateAvailable: false,
  }));
} finally {
  await client.stopAndWait();
}
