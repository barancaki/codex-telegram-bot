import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Bot, Context } from "grammy";
import { AcpClient } from "../src/acp/client.js";
import { resolveCodexPath } from "../src/config.js";
import type { AppConfig } from "../src/config.js";
import { SettingsStore } from "../src/app/settings-store.js";
import { SessionRuntime } from "../src/bot/session-runtime.js";
import { registerMenu } from "../src/bot/handlers/menu.js";
import type { BotDeps } from "../src/bot/deps.js";
import { setLogLevel } from "../src/logger.js";

setLogLevel("error");
const client = new AcpClient({ codexCliPath: "offline", workspace: "fixture", trustAllTools: false });
const calls: Array<{ method: string; params: any }> = [];
let failed = false;
let catalog = [
  { id: "model-a", model: "model-a", displayName: "A", isDefault: true, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "ultra" }] },
  { id: "model-b", model: "model-b", displayName: "B", defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
];
const internal = client as unknown as { request: (method: string, params?: any) => Promise<unknown>; routeNotification: (method: string, params: any) => void };
internal.request = async (method, params) => {
  calls.push({ method, params });
  if (method === "model/list") {
    if (failed) throw new Error("offline fixture");
    return { data: catalog };
  }
  if (method === "config/read") return { config: { model: "model-a", model_reasoning_effort: "high" } };
  if (method === "thread/start") return { thread: { id: "new" }, model: "model-a", reasoningEffort: "high" };
  if (method === "thread/resume") return { thread: { id: params.threadId }, model: "model-b", reasoningEffort: "low" };
  if (method === "turn/start") {
    queueMicrotask(() => internal.routeNotification("turn/completed", { threadId: params.threadId, turn: { id: "turn", status: "completed" } }));
    return { turn: { id: "turn" } };
  }
  return { data: [] };
};

await client.refreshInventories();
assert.deepEqual(client.availableModels[0]?.supportedReasoningEfforts, ["low", "high", "ultra"]);
assert.equal(client.reasoningFor(undefined), "high", "configured effort wins over catalogue recommendation");
await client.loadSession("saved", "fixture");
assert.equal(client.modelFor("saved"), "model-b");
assert.equal(client.reasoningFor("saved"), "low");
await client.setModel("other", "model-a");
client.setReasoning("other", "ultra");
assert.equal(client.modelFor("saved"), "model-b", "another thread cannot change this model");
await client.prompt("other", [{ type: "text", text: "fixture" }]);
const sent = calls.find((c) => c.method === "turn/start")!.params;
assert.equal(sent.model, "model-a");
assert.equal(sent.effort, "ultra");
assert.equal(sent.approvalPolicy, "on-request");
assert.equal(sent.sandboxPolicy.networkAccess, false);
await client.setModel("other", "model-b");
assert.equal(client.reasoningFor("other"), "low", "model switch clears incompatible effort");
await assert.rejects(client.setModel("saved", "unknown"), /Unknown Codex model/);
assert.throws(() => client.setReasoning("saved", "max"), /Unsupported reasoning/);
await client.setModel("other", "");
assert.equal(client.modelFor("other"), "model-a", "clear restores configured default");

const temp = mkdtempSync(join(tmpdir(), "codex-models-"));
const localAppData = process.env.LOCALAPPDATA;
try {
  const settings = new SettingsStore(temp);
  const fresh = new SessionRuntime({} as Api, 43, client, { workspace: "fixture" } as AppConfig, settings);
  await fresh.setModelPref("model-a");
  assert.equal(fresh.reasoning, "high", "configured effort wins when selecting default before a session exists");
  await fresh.setModelPref("");
  assert.equal(fresh.reasoning, "high", "clearing model before a session exists keeps configured effort");
  fresh.dispose();
  settings.update(42, { model: "model-a", reasoning: "ultra", sessionId: "saved" });
  const rt = new SessionRuntime({} as Api, 42, client, { workspace: "fixture" } as AppConfig, settings);
  await rt.prepare();
  assert.equal(rt.model, "model-b", "resume preserves server's session model instead of chat preference");
  assert.equal(rt.reasoning, "low");
  assert.equal((await rt.setModelPref("unknown")).ok, false);
  assert.equal(settings.get(42).model, "model-b", "rejected selection does not persist");
  await rt.setModelPref("model-a");
  await rt.setReasoningPref("ultra");
  assert.equal(rt.reasoning, "ultra");
  assert.equal(settings.get(42).reasoning, "ultra");
  rt.dispose();

  const callbacks = new Map<string, (ctx: Context) => Promise<void>>();
  let keyboard: any;
  registerMenu({ hears: () => {}, callbackQuery: (pattern: RegExp | string, handler: (ctx: Context) => Promise<void>) => callbacks.set(String(pattern), handler) } as unknown as Bot, {
    acp: client, registry: { get: () => rt }, ephemeral: { open: async () => {}, reply: async (_ctx: unknown, _text: string, opts: any) => { keyboard = opts?.reply_markup; } },
  } as unknown as BotDeps);
  const dispatch = callbacks.get(String(/^m:(\w+)$/))!;
  calls.length = 0;
  await dispatch({ chat: { id: 42 }, match: ["m:model", "model"], answerCallbackQuery: async () => {} } as unknown as Context);
  assert.ok(calls.some((c) => c.method === "model/list"), "opening model picker refreshes live catalogue");
  assert.ok(!calls.some((c) => c.method.startsWith("thread/")), "opening picker never starts or resumes a thread");
  assert.ok(keyboard.inline_keyboard.flat().some((b: any) => b.callback_data === "model:set:model-a"), "model callbacks use stable ids");
  await dispatch({ chat: { id: 42 }, match: ["m:reasoning", "reasoning"], answerCallbackQuery: async () => {} } as unknown as Context);
  assert.ok(keyboard.inline_keyboard.flat().some((b: any) => b.callback_data === "reason:ultra"), "reasoning picker uses native supported efforts");
  assert.ok(!keyboard.inline_keyboard.flat().some((b: any) => b.callback_data === "reason:minimal"), "unsupported hardcoded efforts are absent");
  catalog = catalog.slice(0, 1);
  await client.refreshInventories();
  assert.deepEqual(client.availableModels.map((m) => m.modelId), ["model-a"]);
  failed = true;
  await client.refreshInventories();
  assert.equal(client.availableModels.length, 0, "failed refresh cannot display stale models");
  assert.ok(client.modelInventoryError);
  assert.equal(client.hasModel("model-a"), false, "failed catalogue cannot accept arbitrary choices");

  assert.equal(resolveCodexPath("explicit-fixture"), "explicit-fixture");
  if (process.platform === "win32") {
    process.env.LOCALAPPDATA = temp;
    const binary = join(temp, "OpenAI", "Codex", "bin", "fixture", "codex.exe");
    mkdirSync(join(binary, ".."), { recursive: true });
    writeFileSync(binary, "offline fixture");
    assert.equal(resolveCodexPath(), binary, "desktop install is discovered without a version-pinned override");
  }
  console.log("Model self-check passed: live catalogue, native effort, session isolation, resume, menu refresh, desktop resolution.");
} finally {
  if (localAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = localAppData;
  rmSync(temp, { recursive: true, force: true });
}
