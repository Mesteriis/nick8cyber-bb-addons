#!/usr/bin/env node
/**
 * acp-argon — ACP (JSON-RPC stdio) bridge to Google Gemini web client.
 * Wraps the patched google-gemini-cli driver (CDP + headless Chromium).
 * One Gemini tab = one conversation stream; prompts serialize globally.
 *
 * Env:
 *   GEMINI_CHROME_BIN  path to chrome/chromium binary (required on arm64)
 *   ARGON_HEADLESS     headless mode passed to driver (default "native")
 *   ARGON_FAKE         "1" → stub sendPrompt (offline protocol tests)
 *   ARGON_BACKENDS     JSON array of accounts: [{"id","profile","cdp"}]
 *                      (fallback: single backend from GEMINI_CDP_PORT/GEMINI_PROFILE)
 *   ARGON_STATE_DIR    where per-session state lives (default ~/.config/argon-acp)
 */
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(HERE, "package.json"));

// Diagnostics must stay off stdout — it is the JSON-RPC channel.
console.log = console.error;

const FAKE = process.env.ARGON_FAKE === "1";
// null → driver reuses whatever chrome runs; a cold launch defaults to native.
const HEADLESS = process.env.ARGON_HEADLESS || process.env.GEMINI_HEADLESS || null;

/* ---------- account pool: $STATE_DIR/accounts/<label>/backend.json ----------
 * Same shape as the agy provider pool: one directory per Google account —
 * adding an account is adding a directory, no provider config edits.
 *   backend.json: {"profile":"<chrome-profile-id>","cdp":"<port>","priority":N}
 *   priority: int >= 0, default 10; 0 removes the account from rotation.
 * ARGON_BACKENDS (env JSON array of {id,profile,cdp,priority}) still works and
 * is merged underneath — pool dirs win on the same id. With neither, the
 * legacy single GEMINI_CDP_PORT/GEMINI_PROFILE backend is used.
 */
const STATE_DIR = process.env.ARGON_STATE_DIR || join(homedir(), ".config", "argon-acp");
const POOL_DIR = join(STATE_DIR, "accounts");
const LEDGER_FILE = join(STATE_DIR, "accounts-state.json");
const LOCK_DIR = join(STATE_DIR, "accounts-state.lock");

function loadBackends() {
  const byId = new Map();
  try {
    for (const ent of readdirSync(POOL_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      try {
        const b = JSON.parse(readFileSync(join(POOL_DIR, ent.name, "backend.json"), "utf8"));
        const cdp = String(b.cdp ?? b.cdpPort ?? "");
        // Interpolated into pkill -f and RegExp — digits only.
        if (!/^\d{2,5}$/.test(cdp)) continue;
        byId.set(ent.name, {
          id: ent.name,
          profile: b.profile || ent.name,
          cdp,
          priority: Number.isInteger(b.priority) && b.priority >= 0 ? b.priority : 10,
        });
      } catch {}
    }
  } catch {}
  try {
    const arr = JSON.parse(process.env.ARGON_BACKENDS || "");
    if (Array.isArray(arr)) {
      for (const [i, b] of arr.entries()) {
        const id = b.id || `env-${i + 1}`;
        const cdp = String(b.cdp ?? b.cdpPort ?? 9222);
        if (!/^\d{2,5}$/.test(cdp)) continue;
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            profile: b.profile || null,
            cdp,
            priority: Number.isInteger(b.priority) && b.priority >= 0 ? b.priority : 10,
          });
        }
      }
    }
  } catch {}
  if (byId.size === 0) {
    const envCdp = process.env.GEMINI_CDP_PORT || "9222";
    byId.set("default", {
      id: "default",
      profile: process.env.GEMINI_PROFILE || null,
      cdp: /^\d{2,5}$/.test(envCdp) ? envCdp : "9222",
      priority: 10,
    });
  }
  return [...byId.values()];
}
const BACKENDS = loadBackends();
const cdpUrlOf = (b) => `http://localhost:${b.cdp}`;

/* ---------- ledger: accounts-state.json, shared across server processes ----------
 * bb spawns one acp-server per thread, so in-memory state alone cannot rotate
 * accounts — the ledger carries lastUsedMs/cooldowns between processes.
 * Mutations go through a mkdir lockfile + load-merge-save.
 */
const LOCK_STALE_MS = 10_000;
async function lockLedger() {
  mkdirSync(STATE_DIR, { recursive: true });
  const deadline = Date.now() + 12_000; // > LOCK_STALE_MS so a dead holder frees us
  while (Date.now() < deadline) {
    try {
      mkdirSync(LOCK_DIR);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const mtime = statSync(LOCK_DIR).mtimeMs;
        if (Date.now() - mtime > LOCK_STALE_MS) {
          // Atomic stale-break: whoever wins the rename owns the break. A
          // fresh lock can race the stat — verify the renamed dir is the same
          // generation we measured, else put it back untouched.
          const junk = `${LOCK_DIR}.stale-${process.pid}-${Date.now()}`;
          try {
            renameSync(LOCK_DIR, junk);
            if (statSync(junk).mtimeMs !== mtime) {
              // A third process may already hold a new lock — don't clobber it.
              if (!existsSync(LOCK_DIR)) {
                try { renameSync(junk, LOCK_DIR); } catch { rmSync(junk, { recursive: true, force: true }); }
              } else {
                rmSync(junk, { recursive: true, force: true });
              }
            } else {
              rmSync(junk, { recursive: true, force: true });
            }
          } catch {}
          continue;
        }
      } catch { /* lock vanished */ }
      await sleep(100);
    }
  }
  throw new Error("accounts-state lock held for over 12s");
}
function unlockLedger() {
  rmSync(LOCK_DIR, { recursive: true, force: true });
}
function loadLedger() {
  try {
    const l = JSON.parse(readFileSync(LEDGER_FILE, "utf8"));
    // `conversations` from older versions is dropped on next save — dead field.
    // null-prototype: account ids like "__proto__" must stay ordinary keys.
    const accounts = Object.assign(Object.create(null), l.accounts || {});
    return { accounts };
  } catch (e) {
    // Corrupt file → move aside instead of silently dropping parked accounts.
    if (e.code !== "ENOENT" && existsSync(LEDGER_FILE)) {
      try { renameSync(LEDGER_FILE, `${LEDGER_FILE}.corrupt-${Date.now()}`); } catch {}
    }
    return { accounts: Object.create(null) };
  }
}
function saveLedger(ledger) {
  const tmp = `${LEDGER_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2));
  renameSync(tmp, LEDGER_FILE);
}
async function withLedger(fn) {
  await lockLedger();
  try {
    const ledger = loadLedger();
    const r = fn(ledger);
    saveLedger(ledger);
    return r;
  } finally {
    unlockLedger();
  }
}

/**
 * agy-parity pick (spec §2.2 of provider-agy) + cross-process lease:
 * candidates priority>0 → not cooling → not leased by another process →
 * highest priority tier → LRU lastUsedMs → label tie-break.
 * Returns {backend} | {busyUntil:ms} | {cooledUntil:ms} | {none:true}.
 * "busy" = inUseUntilMs lease held by a different owner; a send holds the
 * tab, so a second process must never drive it concurrently.
 */
const LEASE_TTL_MS = 5 * 60 * 1000; // renewed every 60s during a send; crash-safe
// Account ids come from directory names — "__proto__"/"constructor" must not
// hit inherited Object props. Own-property access only.
const accEntry = (ledger, id) =>
  Object.hasOwn(ledger.accounts, id) ? ledger.accounts[id] : undefined;
const accEnsure = (ledger, id) => {
  if (!Object.hasOwn(ledger.accounts, id) || typeof ledger.accounts[id] !== "object" || ledger.accounts[id] === null) {
    ledger.accounts[id] = { cooldownUntilMs: 0, lastUsedMs: 0, lastError: null };
  }
  return ledger.accounts[id];
};
function pickBackendFromLedger(ledger, excludeId, owner, now) {
  const entryOf = (id) => accEntry(ledger, id);
  const busyMsOf = (b) => {
    const e = entryOf(b.id);
    return e && (e.inUseUntilMs ?? 0) > now && e.owner !== owner ? e.inUseUntilMs : 0;
  };
  const candidates = BACKENDS.filter((b) => b.id !== excludeId && b.priority > 0);
  if (candidates.length === 0) return { none: true };
  const free = candidates.filter(
    (b) => (entryOf(b.id)?.cooldownUntilMs ?? 0) <= now && busyMsOf(b) === 0
  );
  if (free.length === 0) {
    const soonest = Math.min(
      ...candidates.map((b) => {
        const freeAt = Math.max(busyMsOf(b), entryOf(b.id)?.cooldownUntilMs ?? 0);
        return freeAt > now ? freeAt : Infinity;
      })
    );
    if (!Number.isFinite(soonest)) return { none: true };
    // Leases expire within LEASE_TTL — a wait is honest. Longer = cooldown,
    // fail fast instead of parking the turn for tens of minutes.
    return soonest <= now + LEASE_TTL_MS + 10_000
      ? { busyUntil: soonest }
      : { cooledUntil: soonest };
  }
  const maxP = Math.max(...free.map((b) => b.priority));
  const tier = free.filter((b) => b.priority === maxP);
  tier.sort(
    (a, b) =>
      (entryOf(a.id)?.lastUsedMs ?? 0) - (entryOf(b.id)?.lastUsedMs ?? 0) ||
      a.id.localeCompare(b.id)
  );
  return { backend: tier[0] };
}

function acquireInLedger(ledger, b, owner, sessionId, now) {
  const e = accEnsure(ledger, b.id);
  e.lastUsedMs = now;
  e.inUseUntilMs = now + LEASE_TTL_MS;
  e.owner = owner;
  // A successful re-acquire means the account is healthy again — clear any
  // sticky park left from an earlier auth probe.
  e.parkedReason = null;
}

async function releaseLease(backendId, sessionId) {
  const owner = `${process.pid}:${sessionId}`;
  await withLedger((l) => {
    const e = accEntry(l, backendId);
    if (e && e.owner === owner) {
      e.inUseUntilMs = 0;
      e.owner = null;
    }
  });
}

/** Cooldown bookkeeping. rotatable = account-attributable cause a sibling can
 * serve (quota wall, auth-dead, missing thinking submenu). untilMs 0 → record
 * lastError only; generic failures never park accounts. */
const QUOTA_COOLDOWN_MS = 30 * 60 * 1000;
const AUTH_DEAD_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const THINKING_MISSING_COOLDOWN_MS = 2 * 60 * 1000;

/** "Limit resets 3:45 PM" → ms timestamp; null when absent/unparseable. */
function quotaResetAtMs(message) {
  const m = String(message).match(/resets?\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (m[3]) {
    const ap = m[3].toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }
  const t = new Date();
  t.setHours(h, min, 0, 0);
  if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

function classifyFailure(err, authHint) {
  const message = err?.message || String(err);
  if (authHint || /auth_required|not authenticated|silent sign-in|sign-in required/i.test(message)) {
    return { untilMs: Date.now() + AUTH_DEAD_COOLDOWN_MS, parkedReason: "auth-dead", rotatable: true };
  }
  if (err && err.code === "ARGON_MODEL_UNAVAILABLE") {
    if (/rate-limited/i.test(message)) {
      return { untilMs: quotaResetAtMs(message) ?? Date.now() + QUOTA_COOLDOWN_MS, rotatable: true };
    }
    if (err.kind === "thinking") {
      // A sibling may still expose the thinking submenu.
      return { untilMs: Date.now() + THINKING_MISSING_COOLDOWN_MS, rotatable: true };
    }
    // Bad or locked model name — a config error, not the account's fault.
    return { untilMs: 0, rotatable: false };
  }
  if (/rate.?limit|quota|resource.?exhaust|too many requests|\b429\b|limit resets/i.test(message)) {
    return { untilMs: quotaResetAtMs(message) ?? Date.now() + QUOTA_COOLDOWN_MS, rotatable: true };
  }
  return { untilMs: 0, rotatable: false };
}

/** Release the lease and record the failure classification in ONE ledger
 * transaction — a sibling must never observe the account free-but-unmarked
 * between the two writes. Returns "cooled" | "breaker". */
async function settleBackend(backendId, sessionId, untilMs, message, parkedReason) {
  const owner = `${process.pid}:${sessionId}`;
  return withLedger((ledger) => {
    const e = accEnsure(ledger, backendId);
    if (e.owner === owner) {
      e.inUseUntilMs = 0;
      e.owner = null;
    }
    e.lastError = String(message).slice(0, 500);
    if (parkedReason) {
      const enabled = BACKENDS.filter((b) => b.priority > 0).length;
      const parked = Object.entries(ledger.accounts).filter(
        ([k, v]) =>
          k !== backendId && v.parkedReason && (v.cooldownUntilMs ?? 0) > Date.now() &&
          BACKENDS.some((b) => b.id === k && b.priority > 0)
      ).length;
      if (enabled > 1 && parked >= enabled - 1) {
        ledger.breaker = { at: Date.now(), reason: parkedReason, account: backendId };
        return "breaker";
      }
      e.parkedReason = parkedReason;
    }
    if (untilMs > 0) e.cooldownUntilMs = Math.max(e.cooldownUntilMs ?? 0, untilMs);
    return "cooled";
  });
}

let driver = null;
function getDriver() {
  if (!driver) driver = require("./src/gemini-driver.js");
  return driver;
}

const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- session state ---------- */
const sessions = new Map(); // sessionId -> { model, thinking, convId, account, backend, cancelled, gen, activeGen }
let sessionCounter = 0;

// Carbon is intentionally absent: the picker shows it, but clicking opens a
// paid-upgrade dialog ("Сменить план") on every current account. Plain "Flash"
// does not exist in the picker at all.
const MODELS = [
  { value: "argon", name: "Argon" },
  { value: "hydrogen", name: "Hydrogen" },
  { value: "pro", name: "Pro" },
  { value: "flash-lite", name: "Flash-Lite" },
];
const THINKING = [
  { value: "low", name: "low" },
  { value: "medium", name: "medium" },
  { value: "high", name: "high" },
];

function configOptionsFor(s) {
  const opts = [
    { id: "model", category: "model", type: "select", currentValue: s.model, options: MODELS },
    { id: "thought_level", category: "thought_level", type: "select", currentValue: s.thinking, options: THINKING },
  ];
  if (BACKENDS.length > 1) {
    opts.push({
      id: "account", category: "account", type: "select", currentValue: s.account || "auto",
      options: [{ value: "auto", name: "auto" }, ...BACKENDS.map((b) => ({ value: b.id, name: b.id }))],
    });
  }
  return opts;
}
const modes = {
  availableModes: [{ id: "default", name: "Default" }],
  currentModeId: "default",
};

/* ---------- global prompt queue (one Gemini tab) ---------- */
let queue = Promise.resolve();
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

/* ---------- fake driver for offline protocol tests ---------- */
async function fakeSendPrompt({ prompt, onChunk }) {
  const chunks = [`[argon-fake] `, prompt.slice(-80), `\n\n(model=${arguments[0].model ?? "?"})`];
  let text = "";
  for (const c of chunks) { text += c; onChunk && onChunk(c); await sleep(30); }
  return text;
}

/* ---------- auth probe on error path ---------- */
async function probeAuthHint(backend) {
  try {
    // No global setCdpPort here — this runs outside the serialized send path.
    // connectOverCDP throws when the port is down; the catch returns null.
    const pw = getDriver().getPlaywright();
    const browser = await pw.chromium.connectOverCDP(cdpUrlOf(backend));
    try {
      for (const ctx of browser.contexts())
        for (const p of ctx.pages()) {
          if (!p.url().includes("gemini.google.com") && !p.url().includes("accounts.google")) continue;
          const st = await p.evaluate(() => {
            const onLogin = location.hostname === "accounts.google.com";
            const onApp = location.pathname.startsWith("/app");
            const editor = !!document.querySelector('div[contenteditable="true"][role="textbox"]');
            const cta = [...document.querySelectorAll("a,button")]
              .filter((e) => e.offsetParent !== null)
              .some((e) => /^\s*(sign in|войти)\s*$/i.test((e.innerText || "").trim()));
            return { onLogin, onApp, editor, cta };
          }).catch(() => null);
          // Strong evidence only: a generic landing-page "Sign in" button or a
          // missing editor for other reasons must not park the account a week.
          if (st && !st.editor && (st.onLogin || (st.cta && st.onApp)))
            return "Gemini web session is NOT authenticated. Complete Google login first (DevTools screencast over bb connect, or cookie injection).";
        }
    } finally { await browser.close().catch(() => {}); }
  } catch {}
  return null;
}

/* ---------- conversation binding (per-session /app/<convId>) ---------- */
const GEMINI_APP = "https://gemini.google.com/app";
async function withGeminiPage(backend, fn) {
  const d = getDriver();
  if (!(await d.isCdpReady(backend.cdp))) return null;
  const pw = d.getPlaywright();
  const browser = await pw.chromium.connectOverCDP(cdpUrlOf(backend));
  try {
    for (const ctx of browser.contexts())
      for (const p of ctx.pages())
        if (p.url().startsWith("https://gemini.google.com")) return await fn(p);
    return null;
  } finally { await browser.close().catch(() => {}); }
}
const convIdOf = (url) => (url.match(/\/app\/([a-zA-Z0-9_-]+)/) || [])[1] || null;

/* ---------- backend bind: sticky per session, agy-parity pick for "auto" ----------
 * Returns {backend} | {busyUntil:ms} | {error}. Acquires the account lease
 * under the ledger lock so no two server processes drive the same tab.
 * Pinned sessions (account != "auto") never rotate — a cooldown on a pinned
 * account fails the prompt instead of silently moving the conversation.
 */
async function bindBackend(s, sessionId) {
  const owner = `${process.pid}:${sessionId}`;
  if (FAKE) {
    s.backend ??= BACKENDS[0];
    return { backend: s.backend };
  }
  if (s.account && s.account !== "auto") {
    const b = BACKENDS.find((x) => x.id === s.account);
    if (!b) {
      return { error: `unknown account "${s.account}" — pool has: ${BACKENDS.map((x) => x.id).join(", ")}` };
    }
    const st = await withLedger((ledger) => {
      const now = Date.now();
      const e = accEntry(ledger, b.id);
      const cool = e?.cooldownUntilMs ?? 0;
      if (cool > now) {
        return { error: `account "${b.id}" is in cooldown until ${new Date(cool).toISOString()}` };
      }
      if ((e?.inUseUntilMs ?? 0) > now && e.owner !== owner) {
        return { busyUntil: e.inUseUntilMs, account: b.id };
      }
      acquireInLedger(ledger, b, owner, sessionId, now);
      return { ok: true };
    });
    if (st.ok) {
      s.backend = b;
      return { backend: b };
    }
    return st;
  }
  const st = await withLedger((ledger) => {
    const now = Date.now();
    if (s.backend) {
      const e = accEntry(ledger, s.backend.id);
      const cool = e?.cooldownUntilMs ?? 0;
      const busy = (e?.inUseUntilMs ?? 0) > now && e.owner !== owner;
      if (cool <= now && !busy) {
        acquireInLedger(ledger, s.backend, owner, sessionId, now);
        return { backend: s.backend };
      }
      // An established conversation is pinned to that chrome — waiting is
      // honest. Without convId nothing binds us here: re-pick a sibling.
      const prev = s.backend.id;
      if (s.convId) {
        if (busy) return { busyUntil: e.inUseUntilMs, account: prev };
        return { error: `account "${prev}" is in cooldown until ${new Date(cool).toISOString()}; this conversation is pinned to it — retry after cooldown or start a new session` };
      }
      const r = pickBackendFromLedger(ledger, prev, owner, now);
      if (r.backend) {
        acquireInLedger(ledger, r.backend, owner, sessionId, now);
        return { backend: r.backend };
      }
      if (r.busyUntil) return { busyUntil: r.busyUntil };
      // No sibling came free — our account is busy (lease expires within TTL):
      // wait it out rather than fail. Only a REAL cooldown earns the message.
      if (busy) return { busyUntil: e.inUseUntilMs, account: prev };
      return { error: `account "${prev}" is in cooldown until ${new Date(cool).toISOString()} and no sibling is free` };
    }
    const r = pickBackendFromLedger(ledger, null, owner, now);
    if (r.backend) {
      acquireInLedger(ledger, r.backend, owner, sessionId, now);
      return { backend: r.backend };
    }
    if (r.busyUntil) return { busyUntil: r.busyUntil };
    if (r.cooledUntil) {
      const brk = ledger.breaker ? ` (breaker: ${ledger.breaker.reason} on ${ledger.breaker.account})` : "";
      return { error: `all accounts are in cooldown; nearest reopen ${new Date(r.cooledUntil).toISOString()}${brk}` };
    }
    return { error: "account pool is empty (no enabled backends)" };
  });
  if (st.backend) s.backend = st.backend;
  return st;
}

/* ---------- prompt runner ---------- */
const SEND_DEADLINE_MS = 6 * 60 * 1000; // absolute cap: waits + nav + 180s stream
async function runPrompt(id, sessionId, text) {
  const s = sessions.get(sessionId) ?? { model: "hydrogen", thinking: "low", convId: null, account: "auto", backend: null };
  sessions.set(sessionId, s);
  const upd = (update) =>
    out({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

  // Generation guard: a detached/cancelled attempt keeps its old gen, so its
  // chunks can never bleed into this turn — even if s.cancelled is reset.
  const gen = (s.gen || 0) + 1;
  s.gen = gen;
  s.activeGen = gen;
  s.cancelled = false;
  try {
    const send = FAKE ? fakeSendPrompt : getDriver().sendPrompt;
    const result = await enqueue(async () => {
      // Cancel may have arrived while this prompt sat in the queue — honor it
      // before spending an account lease or a single driver call.
      if (s.cancelled) return { cancelled: true };
      const maxAttempts = Math.min(BACKENDS.length, 3);
      const waitDeadline = Date.now() + 130_000;
      const turnDeadline = Date.now() + SEND_DEADLINE_MS;
      let attempts = 0;
      let lastErr = null;
      let streamedAny = false;
      while (true) {
        if (s.cancelled) return { cancelled: true };
        const bound = await bindBackend(s, sessionId);
        if (bound.error) throw new Error(bound.error);
        if (bound.busyUntil) {
          if (s.cancelled) return { cancelled: true };
          if (Date.now() >= waitDeadline) {
            throw new Error(`account "${bound.account || "picked"}" is busy until ${new Date(bound.busyUntil).toISOString()}`);
          }
          const wakeAt = Math.min(Date.now() + Math.max(bound.busyUntil - Date.now() + 500, 3000), Date.now() + 15_000);
          while (!s.cancelled && Date.now() < wakeAt) await sleep(500);
          continue;
        }
        if (s.cancelled) {
          await releaseLease(bound.backend.id, sessionId).catch(() => {});
          return { cancelled: true };
        }
        const backend = bound.backend;
        const owner = `${process.pid}:${sessionId}`;
        // The send can outlive the 5-min lease — renew ownership every 60s so
        // no sibling steals the tab; the attempt deadline caps total renewals.
        const renew = FAKE ? null : setInterval(() => {
          void withLedger((l) => {
            const e = accEntry(l, backend.id);
            if (e && e.owner === owner) e.inUseUntilMs = Date.now() + LEASE_TTL_MS;
          }).catch(() => {});
        }, 60_000);
        if (renew) renew.unref?.();
        const attempt = (async () => {
          try {
            if (!FAKE && s.convId) {
              // CDP may be down (chrome killed since last prompt) — bring it
              // up first or withGeminiPage returns null and steering throws.
              await getDriver().ensureChrome({ headless: HEADLESS, profile: backend.profile, port: backend.cdp });
              // Another session may have navigated our single tab to its own
              // chat — steer back. A failure here must not be swallowed: the
              // prompt would land in a foreign chat.
              const steered = await withGeminiPage(backend, async (p) => {
                if (convIdOf(p.url()) !== s.convId) {
                  await p.goto(`${GEMINI_APP}/${s.convId}`, { waitUntil: "domcontentloaded" });
                  await p.waitForTimeout(800);
                }
                return convIdOf(p.url()) === s.convId;
              });
              if (!steered) throw new Error(`failed to steer tab back to conversation ${s.convId}`);
            }
            const r = await send({
              prompt: text,
              model: s.model,
              thinking: s.thinking,
              isNewChat: !s.convId,
              headless: HEADLESS,
              profile: backend.profile,
              cdpPort: backend.cdp,
              strictModel: true,
              ephemeral: false,
              shouldCancel: () => s.cancelled || s.activeGen !== gen,
              onChunk: (c) => { if (c && !s.cancelled && s.activeGen === gen) { streamedAny = true; upd({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: c } }); } },
            });
            if (!FAKE && !s.convId && !s.cancelled) {
              s.convId = await withGeminiPage(backend, (p) => convIdOf(p.url())).catch(() => null);
            }
            return r;
          } finally {
            if (renew) clearInterval(renew);
          }
        })();
        // session/cancel resolves _cancelRes; the driver observes shouldCancel
        // and unwinds quickly. "failed" instead of a rejection: a bare
        // rejection would skip the try/catch below (lease + classify + rotate).
        const remaining = turnDeadline - Date.now();
        if (remaining <= 0) {
          await releaseLease(backend.id, sessionId).catch(() => {});
          throw new Error(`turn exceeded ${SEND_DEADLINE_MS / 60000}min deadline across ${attempts + 1} attempt(s)`);
        }
        const deadlineP = new Promise((res) => {
          const t = setTimeout(() => res("deadline"), remaining);
          t.unref?.();
        });
        const outcome = await Promise.race([
          attempt.then(() => "done", () => "failed"),
          new Promise((res) => { s._cancelRes = () => res("cancelled"); }),
          deadlineP,
        ]);
        s._cancelRes = null;
        if (outcome === "cancelled") {
          // Only our own turn may be marked cancelled — a newer prompt already
          // running (gen bumped) keeps its flag; its gen-gate still mutes us.
          if (s.activeGen === gen) s.cancelled = true;
          // Bounded drain: the driver checks shouldCancel at every poll, so
          // the attempt should settle in seconds. Its port is per-call now —
          // even a zombie can only touch its own backend, never a sibling's.
          await Promise.race([attempt.catch(() => {}), sleep(15_000)]);
          await releaseLease(backend.id, sessionId).catch(() => {});
          return { cancelled: true };
        }
        if (outcome === "deadline") {
          // A hung evaluate/navigation must not hold the queue forever. The
          // lease is released; the zombie attempt is port-local and gen-gated.
          await releaseLease(backend.id, sessionId).catch(() => {});
          throw new Error(`turn exceeded ${SEND_DEADLINE_MS / 60000}min deadline (hung page or stalled generation)`);
        }
        try {
          const r = await attempt; // rethrows send errors into the rotate path
          if (!FAKE) await releaseLease(backend.id, sessionId).catch(() => {});
          return r;
        } catch (err) {
          lastErr = err;
          if (err && err.code === "ARGON_CANCELLED") {
            await releaseLease(backend.id, sessionId).catch(() => {});
            return { cancelled: true };
          }
          if (FAKE) throw err;
          const hint = await probeAuthHint(backend);
          const cls = classifyFailure(err, hint);
          // Release + cool in one transaction (no free-but-unmarked window).
          const cooled = await settleBackend(backend.id, sessionId, cls.untilMs, hint || err.message, cls.parkedReason);
          attempts += 1;
          // Rotate only when the failure is the account's (quota/auth/missing
          // thinking submenu) AND nothing is lost by moving: no established
          // conversation, no partial answer already streamed.
          const canRotate =
            s.account === "auto" && attempts < maxAttempts &&
            cls.rotatable && !s.convId && !streamedAny && cooled !== "breaker";
          if (!canRotate) {
            if (hint) err.authHint = hint;
            throw err;
          }
          // Rotate: drop the binding so the next attempt re-picks a sibling.
          s.backend = null;
        }
      }
      throw lastErr;
    });
    out({ jsonrpc: "2.0", id, result: { stopReason: result && result.cancelled ? "cancelled" : "end_turn" } });
    if (s.activeGen === gen) s.activeGen = null;
  } catch (err) {
    if (s.activeGen === gen) s.activeGen = null;
    const hint = FAKE ? null : (err.authHint ?? await probeAuthHint(s.backend || BACKENDS[0]));
    const msg = hint ? `${hint}\n\n(driver error: ${err.message})` : `Gemini web driver error: ${err.message}`;
    // agy-parity: all turn errors are -32000 with the cause in the message;
    // HTTP-style codes aren't part of this ACP dialect.
    out({ jsonrpc: "2.0", id, error: { code: -32000, message: msg } });
  }
}

/* ---------- ops: unpark an auth-dead account (or all) ----------
 * node acp-server.mjs unpark <accountId|all>
 * Clears parkedReason + cooldown and the pool breaker after re-login. */
if (process.argv[2] === "unpark") {
  const target = process.argv[3] || "all";
  await lockLedger();
  try {
    const ledger = loadLedger();
    const ids = target === "all" ? Object.keys(ledger.accounts) : [target];
    for (const id of ids) {
      const e = accEntry(ledger, id);
      if (e) { e.parkedReason = null; e.cooldownUntilMs = 0; }
    }
    delete ledger.breaker;
    saveLedger(ledger);
    console.error(`unparked: ${ids.join(", ") || "(none)"}`);
  } finally { unlockLedger(); }
  process.exit(0);
}

/* ---------- JSON-RPC loop ---------- */
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
  if (msg.method === undefined) return; // a response, not a request
  if (typeof msg.method !== "string") {
    if (msg.id !== undefined && msg.id !== null) {
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "invalid request: method must be a string" } });
    }
    return;
  }
  try {
    dispatch(msg);
  } catch (e) {
    // A malformed params shape must never take the whole server down.
    if (msg.id !== undefined && msg.id !== null) {
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `internal error: ${e.message}` } });
    }
    console.error(`[argon] dispatch error: ${e.stack || e}`);
  }
});

function dispatch(msg) {
  const p = msg.params ?? {};
  if (msg.id === undefined || msg.id === null) {
    // Notification — never reply on the wire. Only cancel has an effect.
    if (msg.method === "session/cancel") {
      const s = sessions.get(p.sessionId);
      if (s) { s.cancelled = true; s._cancelRes?.(); }
    }
    return;
  }
  switch (msg.method) {
    case "initialize":
      out({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false, promptCapabilities: { image: false }, sessionCapabilities: {} },
        authMethods: [],
      } });
      return;
    case "session/new": {
      const sessionId = `argon-${++sessionCounter}`;
      const s = { model: "hydrogen", thinking: "low", convId: null, account: "auto", backend: null };
      sessions.set(sessionId, s);
      out({ jsonrpc: "2.0", id: msg.id, result: { sessionId, configOptions: configOptionsFor(s), modes } });
      return;
    }
    case "session/load":
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "session/load unsupported" } });
      return;
    case "session/set_mode":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "session/set_config_option": {
      const s = sessions.get(p.sessionId);
      if (!s) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown session "${p.sessionId}"` } });
        return;
      }
      const cid = p.configId ?? p.id ?? p.optionId;
      const val = p.value;
      const known = cid === "model" || cid === "thought_level" || cid === "account";
      const valid = known && typeof val === "string" && (
        cid === "model" ? MODELS.some((m) => m.value === val) :
        cid === "thought_level" ? THINKING.some((t) => t.value === val) :
        val === "auto" || BACKENDS.some((b) => b.id === val)
      );
      if (!valid) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: known ? `unknown ${cid} "${val}"` : `unknown config option "${cid}"` } });
        return;
      }
      if (s) {
        if (cid === "model") s.model = val;
        if (cid === "thought_level") s.thinking = val;
        if (cid === "account" && val !== s.account) {
          // Switching accounts moves the conversation to another chrome —
          // drop backend binding and convId so the next prompt re-picks.
          s.account = val;
          s.backend = null;
          s.convId = null;
        }
      }
      out({ jsonrpc: "2.0", id: msg.id, result: s ? { configOptions: configOptionsFor(s) } : {} });
      return;
    }
    case "session/set_model": {
      const s = sessions.get(p.sessionId);
      if (!s) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown session "${p.sessionId}"` } });
        return;
      }
      const val = p.modelId ?? p.value;
      if (typeof val !== "string" || !MODELS.some((m) => m.value === val)) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown model "${typeof val === "string" ? val : JSON.stringify(val)}"` } });
        return;
      }
      if (s) s.model = val;
      out({ jsonrpc: "2.0", id: msg.id, result: s ? { configOptions: configOptionsFor(s) } : {} });
      return;
    }
    case "session/prompt": {
      if (!sessions.has(p.sessionId)) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown session "${p.sessionId}"` } });
        return;
      }
      if (!Array.isArray(p.prompt)) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "prompt must be an array of blocks" } });
        return;
      }
      const dropped = p.prompt.filter((b) => b && b.type && b.type !== "text").length;
      if (dropped) console.error(`[argon] dropped ${dropped} non-text prompt block(s)`);
      const text = p.prompt.filter((b) => b && b.type === "text").map((b) => String(b.text ?? "")).join("\n");
      if (!text.trim()) {
        out({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "empty prompt" } });
        return;
      }
      void runPrompt(msg.id, p.sessionId, text);
      return;
    }
    case "session/cancel": {
      const s = sessions.get(p.sessionId);
      if (s) { s.cancelled = true; s._cancelRes?.(); }
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    }
    case "authenticate":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    default:
      out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
  }
}
