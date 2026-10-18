#!/usr/bin/env bun
// Per-session job broker for pi-docker --fpga. Runs on the host, listens on a
// unix socket mounted into the sandbox, and runs a configured launcher for a
// request of fixed shape. The sandbox never chooses container settings: it
// names a profile, a directory it already has mounted, a script, and options
// from the profile's allowlist.
import { chmodSync, readFileSync, realpathSync, statSync, unlinkSync, existsSync, accessSync, constants } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { isAbsolute, posix, relative } from "node:path";

type Profile = { launcher: string; args: string[]; options: Record<string, string[]> };
type Mapping = { container: string; host: string; hostReal: string; anchor: string };

const MAX_BODY = 1 << 20;

function usage(msg: string): never {
  console.error(`broker: ${msg}`);
  console.error("usage: broker.ts --socket PATH --config FILE [--parent PID] --map CONTAINER=HOST [--map ...]");
  process.exit(64);
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

function parseArgs(argv: string[]) {
  let socket = "";
  let config = "";
  let parent = 0;
  const maps: Mapping[] = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--socket":
        socket = v ?? usage("--socket needs a value");
        i++;
        break;
      case "--config":
        config = v ?? usage("--config needs a value");
        i++;
        break;
      case "--parent":
        parent = Number(v);
        if (!Number.isInteger(parent) || parent <= 0) usage("--parent needs a pid");
        i++;
        break;
      case "--map": {
        const eq = v?.indexOf("=") ?? -1;
        if (eq < 1) usage(`bad --map ${v}`);
        const container = posix.normalize(v!.slice(0, eq)).replace(/\/+$/, "") || "/";
        const host = v!.slice(eq + 1);
        if (!isAbsolute(container) || !isAbsolute(host)) usage(`--map paths must be absolute: ${v}`);
        const hostReal = realpathSync(host);
        maps.push({ container, host, hostReal, anchor: hostReal });
        i++;
        break;
      }
      default:
        usage(`unknown argument ${argv[i]}`);
    }
  }
  if (!socket || !config || maps.length === 0) usage("--socket, --config and at least one --map are required");
  // A mount nested inside another can be renamed through the outer one, so
  // jobs always mount the outermost root, whose name the sandbox cannot change.
  for (const m of maps)
    for (const o of maps)
      if (o.hostReal.length < m.anchor.length && m.hostReal.startsWith(o.hostReal + "/")) m.anchor = o.hostReal;
  return { socket, config, parent, maps };
}

function loadConfig(file: string): { profiles: Map<string, Profile>; maxJobs: number } {
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const maxJobs = raw.maxJobs ?? 2;
  if (!Number.isInteger(maxJobs) || maxJobs < 1) throw new Error(`${file}: maxJobs must be a positive integer`);
  const profiles = new Map<string, Profile>();
  for (const [name, p] of Object.entries<any>(raw.profiles ?? {})) {
    const launcher = expandHome(String(p.launcher ?? ""));
    if (!isAbsolute(launcher)) throw new Error(`profile ${name}: launcher must be an absolute path`);
    accessSync(launcher, constants.X_OK);
    const args = (p.args ?? []).map(String);
    const options: Record<string, string[]> = Object.create(null);
    for (const [opt, flags] of Object.entries<any>(p.options ?? {})) options[opt] = (flags as unknown[]).map(String);
    profiles.set(name, { launcher, args, options });
  }
  if (profiles.size === 0) throw new Error(`${file}: no profiles`);
  return { profiles, maxJobs };
}

class Refusal extends Error {}

// Container path -> (session root to mount, subdirectory inside it). The job
// container mounts the root and starts in the subdirectory, so symlinks below
// the root resolve inside the job container, never on the host: checking a
// host path and then mounting it would race with the sandbox swapping it.
function resolveCwd(cwd: unknown, maps: Mapping[]): { root: string; sub: string } {
  if (typeof cwd !== "string" || !cwd.startsWith("/")) throw new Refusal("cwd must be an absolute container path");
  const norm = posix.normalize(cwd);
  const m = maps
    .filter((x) => norm === x.container || norm.startsWith(x.container === "/" ? "/" : x.container + "/"))
    .sort((a, b) => b.container.length - a.container.length)[0];
  if (!m) throw new Refusal(`cwd ${cwd} is not inside a mounted directory`);
  if (/[\x00-\x1f\x7f]/.test(norm)) throw new Refusal("cwd contains control characters");
  const lexical = m.hostReal + norm.slice(m.container.length);
  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    throw new Refusal(`cwd ${cwd} does not exist`);
  }
  if (real !== m.hostReal && !real.startsWith(m.hostReal + "/")) throw new Refusal(`cwd ${cwd} resolves outside ${m.container}`);
  if (!statSync(real).isDirectory()) throw new Refusal(`cwd ${cwd} is not a directory`);
  return { root: m.anchor, sub: relative(m.anchor, lexical) };
}

function buildCommand(body: any, profiles: Map<string, Profile>): string[] {
  const p = typeof body.profile === "string" ? profiles.get(body.profile) : undefined;
  if (!p) throw new Refusal(`unknown profile ${JSON.stringify(body.profile)}; known: ${[...profiles.keys()].join(", ")}`);
  const opts = body.options ?? [];
  if (!Array.isArray(opts)) throw new Refusal("options must be an array");
  const flags: string[] = [];
  for (const o of opts) {
    if (typeof o !== "string" || !Object.hasOwn(p.options, o))
      throw new Refusal(`option ${JSON.stringify(o)} not allowed for ${body.profile}; allowed: ${Object.keys(p.options).join(", ") || "none"}`);
    flags.push(...p.options[o]);
  }
  if (typeof body.script !== "string") throw new Refusal("script must be a string");
  return [p.launcher, ...p.args, ...flags];
}

function log(line: string) {
  process.stderr.write(`${new Date().toISOString()} broker: ${line}\n`);
}

const { socket, config, parent, maps } = parseArgs(process.argv.slice(2));
const { profiles, maxJobs } = loadConfig(config);
let running = 0;
if (existsSync(socket)) unlinkSync(socket);

const enc = new TextEncoder();
const frame = (o: object) => enc.encode(JSON.stringify(o) + "\n");

Bun.serve({
  unix: socket,
  idleTimeout: 0,
  maxRequestBodySize: MAX_BODY,
  async fetch(req) {
    if (new URL(req.url).pathname !== "/run" || req.method !== "POST") return new Response("not found\n", { status: 404 });
    let cmd: string[];
    let cwd: { root: string; sub: string };
    let script: string;
    try {
      const text = await req.text();
      let body: any;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Refusal("request is not JSON");
      }
      if (typeof body !== "object" || body === null) throw new Refusal("request must be an object");
      cmd = buildCommand(body, profiles);
      cwd = resolveCwd(body.cwd, maps);
      script = body.script;
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      log(`refused: ${e.message}`);
      return Response.json({ error: e.message }, { status: 400 });
    }

    if (running >= maxJobs) {
      log(`refused: ${running} jobs already running (maxJobs ${maxJobs})`);
      return Response.json({ error: `${running} jobs already running; maxJobs is ${maxJobs}` }, { status: 429 });
    }
    log(`run ${cmd.join(" ")} in ${cwd.root} workdir ${cwd.sub || "."}`);
    running++;
    const proc = Bun.spawn(cmd, {
      cwd: cwd.root,
      env: { ...process.env, BATCH_WORKDIR: cwd.sub },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.exited.then(() => running--);
    proc.stdin.write(script);
    proc.stdin.end();
    const stop = () => {
      if (proc.exitCode === null && proc.signalCode === null) {
        log(`client gone, terminating pid ${proc.pid}`);
        proc.kill("SIGTERM");
      }
    };
    req.signal.addEventListener("abort", stop);

    const stream = new ReadableStream<Uint8Array>({
      async start(ctl) {
        const pump = async (src: ReadableStream<Uint8Array>, key: "o" | "e") => {
          const dec = new TextDecoder();
          for await (const chunk of src) {
            const s = dec.decode(chunk, { stream: true });
            if (s) ctl.enqueue(frame({ [key]: s }));
          }
          const rest = dec.decode();
          if (rest) ctl.enqueue(frame({ [key]: rest }));
        };
        try {
          await Promise.all([pump(proc.stdout, "o"), pump(proc.stderr, "e")]);
          const code = await proc.exited;
          const exit = proc.signalCode ? 128 + (osConstants.signals[proc.signalCode] ?? 0) : code;
          log(`exit ${exit} pid ${proc.pid}`);
          ctl.enqueue(frame({ exit }));
          ctl.close();
        } catch {
          stop();
        }
      },
      cancel: stop,
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  },
});
chmodSync(socket, 0o600);
log(`listening on ${socket}; profiles: ${[...profiles.keys()].join(", ")}; maps: ${maps.map((m) => `${m.container}=${m.host}`).join(" ")}`);

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(sig, () => {
    try {
      unlinkSync(socket);
    } catch {}
    process.exit(0);
  });

// A session killed with SIGKILL never runs its EXIT trap; do not outlive it.
if (parent)
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      log(`parent ${parent} gone, exiting`);
      process.emit("SIGTERM");
    }
  }, 2000);
