// Interactive secret entry that never sends the secret to a model, a log, or an
// argument list.
//
// `read -s` behaves inconsistently across terminals and wrappers, so the hidden
// prompt is implemented here with an explicit tty check and raw mode. Verification
// is by length and prefix only: printing the value, even truncated, is what leaks
// it into a transcript.
//
// Usage:
//   node scripts/ask-secret.mjs                      # prompt, print length only
//   node scripts/ask-secret.mjs --store openrouter   # prompt and write to keychain
//   node scripts/ask-secret.mjs --verify openrouter  # show length of a stored key
//   node scripts/ask-secret.mjs --delete openrouter
//   node scripts/ask-secret.mjs --file               # print a shell-sourceable line

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const SERVICES = {
  openrouter: "pi-mem0-cache.openrouter",
  jina: "pi-mem0-cache.jina",
  mem0: "pi-mem0-cache.mem0",
};

/** Shape checks per provider. Length and prefix only — never the value. */
const SHAPES = {
  openrouter: {
    test: (k) => /^sk-or-v1-[0-9a-f]{40,}$/i.test(k),
    expect: "sk-or-v1- followed by 64 hex characters (~73 total)",
    minLen: 50,
  },
  jina: { test: (k) => /^jina_/i.test(k), expect: "jina_…", minLen: 30 },
  mem0: { test: (k) => k.length >= 20, expect: "a mem0 API key", minLen: 20 },
};

function parseArgs(argv) {
  let out = { mode: "print" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--store") out = { ...out, mode: "store", provider: argv[++i] };
    else if (a === "--verify") out = { ...out, mode: "verify", provider: argv[++i] };
    else if (a === "--delete") out = { ...out, mode: "delete", provider: argv[++i] };
    else if (a === "--file") out = { ...out, mode: "file", provider: argv[++i] };
    else if (a === "--list" || a === "-l") out = { ...out, mode: "list" };
    else if (a === "--help" || a === "-h") out = { ...out, mode: "help" };
    // A bare provider name selects that provider while keeping the prompt, so
    // `setup-key.sh openrouter` reads as the obvious thing it should.
    else if (!a.startsWith("-") && out.provider === undefined) out = { ...out, provider: a };
  }
  return out;
}

/** Read one line with no echo. Requires a real terminal: a piped stdin would make
 *  the value visible to whatever is reading the pipe. */
function promptHidden(label) {
  if (!process.stdin.isTTY) {
    console.error("error: needs an interactive terminal (stdin is not a TTY)");
    process.exit(1);
  }
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress echo while still letting the user backspace before Enter.
    const onData = (chunk) => {
      const s = chunk.toString("utf8");
      for (const ch of s) {
        if (ch === "\n" || ch === "\r") continue;
        if (ch === "\u007f" || ch === "\b") process.stdout.write("\b \b");
        else process.stdout.write("*");
      }
    };
    process.stdin.on("data", onData);
    rl.question("", (answer) => {
      process.stdin.removeListener("data", onData);
      rl.close();
      process.stdout.write("\n");
      const value = answer.trim();
      if (!value) reject(new Error("empty input, nothing stored"));
      else resolve(value);
    });
  });
}

function keychainStore(service, value) {
  // -U updates an existing entry, which avoids a delete-then-add window where a
  // failure would leave no credential at all.
  execFileSync("security", ["add-generic-password", "-a", process.env.USER ?? "user", "-s", service, "-w", value, "-U"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function keychainRead(service) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

function describe(provider, value) {
  const shape = SHAPES[provider];
  const ok = shape ? shape.test(value) : true;
  const lines = [
    `  provider : ${provider}`,
    `  length   : ${value.length}`,
    `  prefix   : ${value.slice(0, 9)}…`,
  ];
  if (shape) lines.push(`  expected : ${shape.expect}`, `  shape ok : ${ok ? "yes" : "NO — check what you pasted"}`);
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));

if (args.mode === "help") {
  console.log(`store a pi-mem0-cache credential in the macOS Keychain (never in a file)

  node scripts/ask-secret.mjs                 prompt for the default provider and store
  node scripts/ask-secret.mjs openrouter      prompt for a named provider (
                                            openrouter | jina | mem0)
  node scripts/ask-secret.mjs --store NAME    same as above, explicitly
  node scripts/ask-secret.mjs --verify NAME   read one back and check its shape
  node scripts/ask-secret.mjs --list          which providers hold a key
  node scripts/ask-secret.mjs --delete NAME   remove one
  node scripts/ask-secret.mjs --file NAME     print a shell-sourceable export line

Only the length and the first characters are ever printed.`);
  process.exit(0);
}

if (args.mode === "list") {
  console.log("Keychain entries for pi-mem0-cache:");
  let found = 0;
  for (const [provider, service] of Object.entries(SERVICES)) {
    const value = keychainRead(service);
    if (value) {
      const shape = SHAPES[provider];
      const ok = shape ? shape.test(value) : true;
      // A stored key that fails its own shape check is the failure mode this tool
      // exists to catch, so it gets said out loud.
      console.log(`  ${provider.padEnd(11)} SET  len ${String(value.length).padStart(3)}  shape ${ok ? "ok" : "NO — re-store it"}`);
      found++;
    } else {
      console.log(`  ${provider.padEnd(11)} -`);
    }
  }
  if (found === 0) console.log("  (none — run without arguments to add one)");
  process.exit(0);
}

if (args.mode === "verify") {
  const service = SERVICES[args.provider];
  if (!service) {
    console.error(`unknown provider: ${args.provider} (known: ${Object.keys(SERVICES).join(", ")})`);
    process.exit(1);
  }
  const value = keychainRead(service);
  if (!value) {
    console.log(`${args.provider}: NOT SET (service ${service})`);
    process.exit(1);
  }
  console.log(`${args.provider}: SET (service ${service})`);
  console.log(describe(args.provider, value));
  process.exit(0);
}

if (args.mode === "delete") {
  const service = SERVICES[args.provider];
  if (!service) {
    console.error(`unknown provider: ${args.provider}`);
    process.exit(1);
  }
  try {
    execFileSync("security", ["delete-generic-password", "-s", service], { stdio: ["ignore", "ignore", "ignore"] });
    console.log(`deleted: ${service}`);
  } catch {
    console.log(`not found: ${service}`);
  }
  process.exit(0);
}

if (args.mode === "file") {
  const service = SERVICES[args.provider];
  const value = service ? keychainRead(service) : undefined;
  if (!value) {
    console.error(`${args.provider}: no key stored`);
    process.exit(1);
  }
  // Caller is expected to eval this in their own shell. It never enters a file.
  console.log(`export ${args.provider.toUpperCase()}_API_KEY='${value.replace(/'/g, "'\\''")}'`);
  process.exit(0);
}

const provider = args.provider ?? "openrouter";
const service = SERVICES[provider];
if (!service) {
  console.error(`unknown provider: ${provider} (known: ${Object.keys(SERVICES).join(", ")})`);
  process.exit(1);
}

console.log(`Entering a key for: ${provider}`);
console.log(`Keychain service  : ${service}`);
console.log("");
console.log("Paste the key and press Enter. Typed characters show as * and the");
console.log("value goes only to the macOS Keychain.");
console.log("");

let key;
try {
  key = await promptHidden("key: ");
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}

console.log("read:");
console.log(describe(provider, key));

const shape = SHAPES[provider];
if (shape && !shape.test(key) && key.length < shape.minLen) {
  console.log("");
  console.log(`refusing to store: that is far shorter than ${shape.expect}.`);
  console.log("Nothing was written. Re-run and paste the full key.");
  process.exit(1);
}

if (args.mode === "store") {
  keychainStore(service, key);
  const check = keychainRead(service);
  if (check !== key) {
    console.error("error: stored value does not read back identically — nothing was left in a half state");
    process.exit(1);
  }
  console.log("");
  console.log(`stored in Keychain: ${service}`);
  console.log(`verify with: node scripts/ask-secret.mjs --verify ${provider}`);
}
