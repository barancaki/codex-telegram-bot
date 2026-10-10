import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context } from "grammy";
import { InstanceLock } from "../src/app/instance-lock.js";
import { loadConfig } from "../src/config.js";
import { createAuthMiddleware } from "../src/bot/auth.js";
import { PermissionService } from "../src/bot/permission-service.js";
import type { RuntimeRegistry } from "../src/bot/registry.js";
import type { RequestPermissionParams } from "../src/acp/types.js";

const original = { ...process.env };
const dir = mkdtempSync(join(tmpdir(), "codex-tg-security-"));
try {
  process.env.TELEGRAM_BOT_TOKEN = "123456:offline-test";
  process.env.ALLOWED_USERS = "42";
  process.env.TELEGRAM_BOT_TOKEN = "not-a-token";
  assert.throws(loadConfig, /TELEGRAM_BOT_TOKEN/);
  process.env.TELEGRAM_BOT_TOKEN = "123456:offline-test";
  delete process.env.CODEX_TRUST_ALL_TOOLS;
  for (const invalid of ["", "username", "-1", "1,abc", "0", "9007199254740993"]) {
    process.env.ALLOWED_USERS = invalid;
    assert.throws(loadConfig, /ALLOWED_USERS/);
  }
  process.env.ALLOWED_USERS = "42, 123";
  const cfg = loadConfig();
  assert.equal(cfg.trustAllTools, false);
  assert.deepEqual([...cfg.allowedUsers], ["42", "123"]);

  let accepted = 0;
  const context = (id: number) => ({ from: { id, is_bot: false }, chat: { id }, reply: async () => {} }) as unknown as Context;
  await createAuthMiddleware(cfg)(context(42), async () => { accepted++; });
  await createAuthMiddleware(cfg)(context(99), async () => { accepted++; });
  assert.equal(accepted, 1);
  await createAuthMiddleware({ ...cfg, allowedUsers: new Set() })(context(42), async () => { accepted++; });
  assert.equal(accepted, 1, "an empty allowlist must not allow everybody");

  const request = { sessionId: "test", options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } as RequestPermissionParams;
  const orphan = { describeSession: () => ({ chatId: undefined }) } as unknown as RuntimeRegistry;
  assert.equal((await new PermissionService({} as Api, orphan).handle(request)).outcome.outcome, "cancelled");
  const owned = { describeSession: () => ({ chatId: 42 }), get: () => ({ sessionId: "test" }) } as unknown as RuntimeRegistry;
  const unavailable = { sendMessage: async () => { throw new Error("offline fixture"); } } as unknown as Api;
  assert.equal((await new PermissionService(unavailable, owned).handle(request)).outcome.outcome, "cancelled");

  const first = new InstanceLock("offline-lock", dir, false);
  const second = new InstanceLock("offline-lock", dir, false);
  assert.equal(await first.acquire(), true);
  assert.equal(await second.acquire(), false, "second instance must yield without terminating the owner");
  first.release();
  assert.equal(await second.acquire(), true);
  second.release();
  const hash = createHash("sha256").update("unrelated-live-owner").digest("hex").slice(0, 16);
  writeFileSync(join(dir, `${hash}.lock`), JSON.stringify({ pid: process.ppid, startedAt: 1, supervised: false }));
  assert.equal(await new InstanceLock("unrelated-live-owner", dir, false).acquire(), false);
  const staleHash = createHash("sha256").update("dead-owner").digest("hex").slice(0, 16);
  writeFileSync(join(dir, `${staleHash}.lock`), JSON.stringify({ pid: 2147483647, startedAt: 1, supervised: false }));
  const recovered = new InstanceLock("dead-owner", dir, false);
  assert.equal(await recovered.acquire(), true, "dead owner may be reclaimed without killing anything");
  recovered.release();
  console.log("Security self-check passed: config, auth, approvals, exclusive ownership.");
} finally {
  process.env = original;
  rmSync(dir, { recursive: true, force: true });
}
