/**
 * Reasoning effort — a per-chat preference that steers how much deliberation
 * the agent applies. Values come from Codex's live model catalogue.
 */
import type { ReasoningEffort } from "./types.js";

export function reasoningLabel(effort: ReasoningEffort): string {
  return effort ? effort[0]!.toUpperCase() + effort.slice(1) : "Default";
}
