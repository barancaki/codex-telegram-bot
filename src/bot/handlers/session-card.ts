/**
 * Builds a rich, readable "card" for a single Codex session: a plain-text body
 * (no MarkdownV2 so Windows paths and titles never need escaping) plus an
 * inline keyboard with Connect / History / Watch actions.
 *
 * Callback data is unchanged (`sess:` / `hist:` / `watch:` + UUID) so the
 * existing handlers in sessions.ts keep working.
 */
import { InlineKeyboard } from "grammy";
import { basename } from "node:path";
import { progressBar } from "../../render/progress.js";
import type { SessionMeta } from "../../sessions/types.js";

export interface SessionCardExtras {
  /** Context-usage %, when the session is loaded in the current ACP process. */
  contextPct?: number;
  /**
   * PID of the bot's own `codex app-server` process. A session locked by this PID
   * powers the bot itself, so its card omits the Kill button (killing it would
   * take the bot down). Other live sessions get a 🛑 Kill button.
   */
  selfPid?: number;
  /** Latest task-completion % (0–100) for this session, if this chat runs it. */
  progress?: number;
}

export interface SessionCard {
  text: string;
  keyboard: InlineKeyboard;
}

/** One compact picker; full details are opened only after a title is selected. */
export function buildSessionPage(metas: SessionMeta[], heading: string, page: number): SessionCard {
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(metas.length / pageSize));
  const current = Math.min(Math.max(0, page), totalPages - 1);
  const start = current * pageSize;
  const keyboard = new InlineKeyboard();
  const lines = [`${heading} · ${metas.length} sohbet · Sayfa ${current + 1}/${totalPages}`, ""];
  for (const [index, meta] of metas.slice(start, start + pageSize).entries()) {
    const number = start + index + 1;
    const title = meta.title.length > 70 ? meta.title.slice(0, 69) + "…" : meta.title;
    lines.push(`${number}. ${title}`, `   ${meta.cwd ? basename(meta.cwd) : "Proje yok"} · ${sessionDate(meta.updatedAt)}`);
    keyboard.text(`${number}. ${title}`, `sc:${meta.sessionId}:${current}`).row();
  }
  if (current > 0) keyboard.text("◀ Önceki", `sp:${current - 1}`);
  if (totalPages > 1) keyboard.text(`${current + 1}/${totalPages}`, "noop");
  if (current < totalPages - 1) keyboard.text("Sonraki ▶", `sp:${current + 1}`);
  lines.push("", "Başlığı seç → ayrıntı ve bağlantı seçenekleri", "Ara: /sessions kelime · Doğrudan: /sessions UUID");
  return { text: lines.join("\n"), keyboard };
}

/** Build the card body + buttons for one session. */
export function buildSessionCard(m: SessionMeta, extra: SessionCardExtras = {}): SessionCard {
  const state = m.active ? "Çalışıyor" : "Kaydedilmiş sohbet";
  const proj = m.cwd ? basename(m.cwd) : "Proje yok";

  const lines = [`${m.title}`, `Proje: ${proj}`];
  if (m.cwd) lines.push(`   ${m.cwd}`);
  lines.push(`Güncelleme: ${sessionDate(m.updatedAt)}`, `Oluşturma: ${sessionDate(m.createdAt)}`);
  const ctx = typeof extra.contextPct === "number" ? ` · Bağlam ${Math.round(extra.contextPct)}%` : "";
  lines.push(`${state} · Geçmiş ${humanSize(m.historyBytes)}${ctx}`);
  if (typeof extra.progress === "number") lines.push(`\u{1F4C8} ${progressBar(extra.progress)}`);
  lines.push(`ID: ${m.sessionId}`);

  const connect = m.active ? "Devam et (kopya)" : "Bağlan";
  const keyboard = new InlineKeyboard()
    .text(connect, `sess:${m.sessionId}`)
    .text("Geçmiş", `hist:${m.sessionId}`)
    .text("İzle", `watch:${m.sessionId}`);

  // A live session running in another process can be terminated by PID. The
  // bot's own agent (selfPid) is never offered — killing it would stop the bot.
  if (m.active && typeof m.lockPid === "number" && m.lockPid !== extra.selfPid) {
    keyboard.row().text(`\u{1F6D1} Kill \u00B7 pid ${m.lockPid}`, `killsess:${m.sessionId}`);
  }

  return { text: lines.join("\n"), keyboard };
}

function sessionDate(iso: string): string {
  const time = new Date(iso);
  if (!Number.isFinite(time.getTime())) return "Tarih bilinmiyor";
  return time.toLocaleString("tr-TR", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** Human-readable byte size, e.g. "812 B", "42.3 KB", "1.2 MB". */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
