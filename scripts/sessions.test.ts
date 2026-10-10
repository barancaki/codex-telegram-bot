import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Bot, Context } from "grammy";
import { SessionStore } from "../src/sessions/store.js";
import { MenuCache, type BotDeps } from "../src/bot/deps.js";
import { showSessions, registerSessions } from "../src/bot/handlers/sessions.js";
import { buildSessionPage } from "../src/bot/handlers/session-card.js";

const dir = mkdtempSync(join(tmpdir(), "codex-tg-sessions-"));
const sessionsDir = join(dir, "sessions");
mkdirSync(sessionsDir);
const id = (number: number) => `00000000-0000-0000-0000-${String(number).padStart(12, "0")}`;
const userMessage = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
try {
  for (let index = 0; index < 451; index++) {
    const file = join(sessionsDir, `rollout-2024-01-01-${id(index)}.jsonl`);
    writeFileSync(file, [
      JSON.stringify({ type: "session_meta", timestamp: "2024-01-01T00:00:00Z", payload: { id: id(index), cwd: join(dir, "project") } }),
      userMessage("# AGENTS.md instructions for project\n<INSTRUCTIONS>private setup</INSTRUCTIONS>"),
      userMessage("<environment_context>local setup</environment_context>"),
      userMessage(index === 450 ? "Older needle conversation" : `Actual request ${index}`),
    ].join("\n"));
    utimesSync(file, new Date("2024-01-01"), new Date(1704067200000 + (450 - index) * 1000));
  }
  writeFileSync(join(dir, "session_index.jsonl"), [
    JSON.stringify({ id: id(0), thread_name: "Desktop title", updated_at: "2025-01-01T00:00:00Z" }),
    JSON.stringify({ id: id(0), thread_name: "Desktop renamed title", updated_at: "2026-01-01T00:00:00Z" }),
    JSON.stringify({ id: id(1), thread_name: "New desktop conversation", updated_at: "2026-10-01T00:00:00Z" }),
    "{partial appended row",
  ].join("\n"));
  const store = new SessionStore(sessionsDir);
  assert.equal(store.get(id(0))?.title, "Desktop renamed title", "desktop name must beat injected AGENTS");
  assert.equal(store.get(id(2))?.title, "Actual request 2", "fallback must skip setup messages");
  assert.equal(store.list(1)[0]?.sessionId, id(1), "desktop index recency must participate in sorting");
  const all = store.list(Infinity);
  assert.equal(all.length, 451);

  const messages: { text: string; extra: any }[] = [];
  const ctx = { chat: { id: 42 } } as unknown as Context;
  const deps = {
    store,
    menuCache: new MenuCache(),
    ephemeral: { open: async () => {}, reply: async (_ctx: Context, text: string, extra: any) => messages.push({ text, extra }) },
    acp: { metadataFor: () => undefined },
    registry: { controller: () => ({ progressFor: () => undefined }) },
  } as unknown as BotDeps;
  await showSessions(ctx, deps);
  assert.equal(messages.length, 1, "picker must send exactly one message");
  assert.equal(messages[0]!.extra.reply_markup.inline_keyboard.filter((row: any[]) => row.some((button) => button.callback_data?.startsWith("sc:"))).length, 10);
  messages.length = 0;
  await showSessions(ctx, deps, "needle");
  assert.equal(deps.menuCache.getSessions(42)?.metas[0]?.sessionId, id(450), "search must reach beyond the former 400-session cap");
  assert.equal(messages.length, 1);
  messages.length = 0;
  await showSessions(ctx, deps, id(0));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.text, /Desktop renamed title/);
  const actions = messages[0]!.extra.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
  assert(actions.includes(`sess:${id(0)}`) && actions.includes(`hist:${id(0)}`) && actions.includes(`watch:${id(0)}`));

  const secondPage = buildSessionPage(all, "Son sohbetler", 1);
  const nav = secondPage.keyboard.inline_keyboard.flat().map((button: any) => button.callback_data);
  assert(nav.includes("sp:0") && nav.includes("sp:2"));
  const lastPage = buildSessionPage(all, "Son sohbetler", 999);
  assert.equal(lastPage.keyboard.inline_keyboard.flat().filter((button: any) => button.callback_data?.startsWith("sc:")).length, 1);

  const commands: string[] = [];
  const callbacks: RegExp[] = [];
  registerSessions({ command: (name: string | string[]) => commands.push(...[name].flat()), callbackQuery: (pattern: RegExp) => callbacks.push(pattern) } as unknown as Bot, deps);
  assert(commands.includes("sessions") && commands.includes("sohbet"));
  assert(callbacks.some((pattern) => pattern.test(`sc:${id(0)}:2`)), "detail callback must be registered");
  assert(callbacks.some((pattern) => pattern.test(`sess:${id(0)}`)), "old resume callbacks must remain compatible");
  writeFileSync(join(dir, "session_index.jsonl"), JSON.stringify({ id: id(0), thread_name: "Newly renamed in desktop", updated_at: "2026-10-02T00:00:00Z" }));
  assert.equal(store.get(id(0))?.title, "Newly renamed in desktop", "get must refresh the title index");
  rmSync(join(dir, "session_index.jsonl"));
  assert.equal(store.get(id(0))?.title, "Actual request 0", "older installs without an index must still work");
  console.log("Session self-check passed: desktop names, setup fallback, full search, single-message paging, UUID and existing callbacks.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
