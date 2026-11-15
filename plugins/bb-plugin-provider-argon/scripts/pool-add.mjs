// Add an account to the argon rotation pool (agy-parity: pool = dir of accounts).
// usage: node scripts/pool-add.mjs <label> <cdp-port> [priority]
//   <label>   = pool id AND chrome profile id (~/.config/google-chrome-<label>)
// Steps it does: write $ARGON_STATE_DIR/accounts/<label>/backend.json, spawn
// the account's chrome under xvfb on <cdp-port>. Then run scripts/glogin.mjs
// <email> <secrets.env> with GEMINI_CDP_PORT=<port> to sign in.
import fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire("/home/ubuntu/.local/share/argon-gemini/package.json");
const driver = require("/home/ubuntu/.local/share/argon-gemini/src/gemini-driver.js");

const [label, port, prio] = process.argv.slice(2);
if (!label || !port) {
  console.error("usage: node scripts/pool-add.mjs <label> <cdp-port> [priority]");
  process.exit(2);
}
const STATE_DIR = process.env.ARGON_STATE_DIR || join(homedir(), ".config", "argon-acp");
const dir = join(STATE_DIR, "accounts", label);
fs.mkdirSync(dir, { recursive: true });
const backend = { profile: label, cdp: String(port) };
if (prio !== undefined) backend.priority = parseInt(prio, 10);
fs.writeFileSync(join(dir, "backend.json"), JSON.stringify(backend, null, 2) + "\n");
console.log(`pool entry: ${dir}/backend.json ->`, JSON.stringify(backend));

// Spawn chrome so glogin can connect over CDP right away.
process.env.GEMINI_CHROME_BIN ||= "/home/ubuntu/.cache/ms-playwright/chromium-1255/chrome-linux-arm64/chrome";
driver.setCdpPort(String(port));
await driver.ensureChrome({ headless: "xvfb", profile: label });
console.log(`chrome up on :${port} (profile ${label}). Next:`);
console.log(`  GEMINI_CDP_PORT=${port} GEMINI_PROFILE=${label} node scripts/glogin.mjs <email> <secrets.env>`);
