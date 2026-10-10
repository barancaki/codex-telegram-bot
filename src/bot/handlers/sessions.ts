/**
 * /sessions — list recent Codex sessions and connect to one.
 * /active   — list sessions currently running on this PC.
 * /unwatch  — stop following a live session.
 *
 * One compact title picker opens a single detail card on demand.
 */
import { type Bot, type Context } from "grammy";
import { basename } from "node:path";
import type { BotDeps } from "../deps.js";
import { readHistory } from "../../sessions/history.js";
import type { SessionMeta } from "../../sessions/types.js";
import { refreshMenu } from "../menu/refresh.js";
import { showHistory } from "./history.js";
import { buildSessionCard, buildSessionPage } from "./session-card.js";

const UUID = "([0-9a-fA-F-]{36})";

export async function showSessions(ctx: Context, deps: BotDeps, query?: string): Promise<void> {
  const q = (query ?? "").trim().toLowerCase();
  if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(q)) {
    await showSessionDetails(ctx, deps, q, 0);
    return;
  }
  let metas = deps.store.list(Infinity);
  if (q) {
    metas = metas.filter((m) => `${m.title} ${m.cwd} ${m.sessionId}`.toLowerCase().includes(q));
  }
  if (metas.length === 0) {
    await deps.ephemeral.open(ctx);
    await deps.ephemeral.reply(ctx, q ? `“${q}” için sohbet bulunamadı.` : "Kaydedilmiş Codex sohbeti bulunamadı.");
    return;
  }
  deps.menuCache.setSessions(ctx.chat!.id, metas, q ? `Arama: “${q.slice(0, 100)}”` : "Son sohbetler");
  await renderSessionPage(ctx, deps, 0);
}

/** Render exactly one compact picker message per page. */
async function renderSessionPage(ctx: Context, deps: BotDeps, page: number): Promise<void> {
  await deps.ephemeral.open(ctx);
  const cached = deps.menuCache.getSessions(ctx.chat!.id);
  if (!cached) return;
  const { text, keyboard } = buildSessionPage(cached.metas, cached.heading, page);
  await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
}

async function showSessionDetails(ctx: Context, deps: BotDeps, id: string, page: number): Promise<void> {
  await deps.ephemeral.open(ctx);
  const meta = deps.store.get(id.toLowerCase());
  if (!meta) {
    await deps.ephemeral.reply(ctx, "Sohbet bulunamadı. /sessions ile listeyi yenile.");
    return;
  }
  const contextPct = deps.acp.metadataFor(meta.sessionId)?.contextUsagePercentage;
  const progress = deps.registry.controller(ctx.chat!.id).progressFor(meta.sessionId);
  const { text, keyboard } = buildSessionCard(meta, { contextPct, selfPid: deps.acp.pid, progress });
  if (deps.menuCache.getSessions(ctx.chat!.id)) keyboard.row().text("◀ Listeye dön", `sp:${page}`);
  await deps.ephemeral.reply(ctx, text, { reply_markup: keyboard });
}

export function registerSessions(bot: Bot, deps: BotDeps): void {
  bot.command(["sessions", "sohbet"], (ctx) => showSessions(ctx, deps, ctx.match?.toString()));

  bot.command("active", async (ctx) => {
    const metas = deps.store.listActive();
    if (metas.length === 0) {
      await deps.ephemeral.open(ctx);
      await deps.ephemeral.reply(ctx, "Masaüstündeki canlı durum diskten görülemiyor. Kaydedilmiş sohbetler: /sessions · Botun yönettiği sohbetler: /running");
      return;
    }
    deps.menuCache.setSessions(ctx.chat!.id, metas, "Çalışan sohbetler");
    await renderSessionPage(ctx, deps, 0);
  });

  bot.callbackQuery(/^sp:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderSessionPage(ctx, deps, Number(ctx.match![1]));
  });

  bot.callbackQuery(new RegExp(`^sc:${UUID}:(\\d+)$`), async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSessionDetails(ctx, deps, ctx.match![1]!, Number(ctx.match![2]));
  });

  bot.command("unwatch", async (ctx) => {
    const rt = deps.registry.get(ctx.chat.id);
    await ctx.reply(rt.stopWatch() ? "İzleme durduruldu." : "İzlenen sohbet yok.");
  });

  bot.callbackQuery(new RegExp(`^sess:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    const meta = deps.store.get(id);
    if (!meta) {
      await ctx.answerCallbackQuery({ text: "Sohbet bulunamadı." });
      return;
    }
    await ctx.answerCallbackQuery();
    await deps.ephemeral.clear(ctx.chat!.id); // remove the session cards
    const fgCwd = deps.registry.get(ctx.chat!.id).cwd;
    const cwd = meta.cwd || fgCwd;
    const projectName = basename(meta.cwd || fgCwd) || "session";
    const prior = readHistory(deps.store.jsonlPath(id), 24);
    try {
      const { result, alreadyControlled } = await deps.registry
        .controller(ctx.chat!.id)
        .addAttach(id, cwd, projectName, prior);
      await ctx.reply(alreadyControlled ? `Geçildi: ${meta.title}` : connectMessage(result, meta));
      await refreshMenu(ctx, deps, `\u{1F4C2} ${meta.title}`);
      await showHistory(deps, ctx.chat!.id, id, meta);
    } catch (err) {
      await ctx.reply(`Bağlanılamadı: ${(err as Error).message}`);
    }
  });

  bot.callbackQuery(new RegExp(`^hist:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    const meta = deps.store.get(id);
    await showHistory(deps, ctx.chat!.id, id, meta);
  });

  bot.callbackQuery(new RegExp(`^watch:${UUID}$`), async (ctx) => {
    const id = ctx.match![1]!;
    await ctx.answerCallbackQuery();
    const meta = deps.store.get(id);
    const rt = deps.registry.get(ctx.chat!.id);
    rt.startWatch(deps.store.jsonlPath(id));
    await ctx.reply(
      `İzleniyor: ${meta?.title ?? id.slice(0, 8)}\nYeni içerik buraya gelir. Durdurmak için /unwatch.`,
    );
  });
}

function connectMessage(result: "resumed" | "forked", meta: SessionMeta): string {
  if (result === "resumed") {
    return `Bağlandı: ${meta.title}\n${meta.cwd}\n\nDevam etmek için mesaj gönder.`;
  }
  return [
    `“${meta.title}” aynı oturumdan sürdürülemedi.`,
    `Aynı projede, son bağlamıyla bağlantılı bir devam sohbeti açıldı.`,
    `${meta.cwd}`,
    ``,
    `Devam etmek için mesaj gönder; asıl sohbeti salt okunur takip etmek için İzle'yi kullan.`,
  ].join("\n");
}
