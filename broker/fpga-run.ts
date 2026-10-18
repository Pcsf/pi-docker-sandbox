#!/usr/bin/env bun
// Sandbox-side client for the pi-docker --fpga broker.
const USAGE = `usage: fpga-run [-o OPTION]... PROFILE -- COMMAND [ARG]...
       fpga-run [-o OPTION]... PROFILE < script.sh

Runs COMMAND (or a script read from stdin) in the PROFILE toolchain container,
in the current directory, and exits with its exit code. Profiles and options
come from the host broker configuration; a refusal lists the allowed values.
Typical profiles: vivado (options: frozen-time, usb), altera (option: usb).`;

const sock = process.env.PI_BROKER_SOCK ?? "/run/pi-broker/broker.sock";
const argv = process.argv.slice(2);
const options: string[] = [];
let profile = "";
let command: string[] | null = null;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") {
    command = argv.slice(i + 1);
    break;
  } else if (a === "-o" || a === "--option") {
    options.push(argv[++i] ?? "");
  } else if (a === "-h" || a === "--help") {
    console.log(USAGE);
    process.exit(0);
  } else if (!profile) {
    profile = a;
  } else {
    console.error(USAGE);
    process.exit(64);
  }
}
if (!profile || (command !== null && command.length === 0)) {
  console.error(USAGE);
  process.exit(64);
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);
const script = command ? command.map(quote).join(" ") + "\n" : await Bun.stdin.text();

let res: Response;
try {
  res = await fetch("http://broker/run", {
    unix: sock,
    method: "POST",
    body: JSON.stringify({ profile, cwd: process.cwd(), script, options }),
  } as RequestInit);
} catch (e) {
  console.error(`fpga-run: cannot reach the broker at ${sock}: ${(e as Error).message}`);
  console.error("fpga-run: start the session with pi-docker --fpga");
  process.exit(2);
}
if (!res.ok) {
  const msg = await res.text();
  let detail = msg;
  try {
    detail = JSON.parse(msg).error ?? msg;
  } catch {}
  console.error(`fpga-run: refused: ${detail}`);
  process.exit(2);
}

let exit = 1;
let buf = "";
const dec = new TextDecoder();
const handle = (line: string) => {
  if (!line) return;
  const f = JSON.parse(line);
  if (f.o !== undefined) process.stdout.write(f.o);
  if (f.e !== undefined) process.stderr.write(f.e);
  if (f.exit !== undefined) exit = f.exit;
};
for await (const chunk of res.body!) {
  buf += dec.decode(chunk, { stream: true });
  let nl: number;
  while ((nl = buf.indexOf("\n")) >= 0) {
    handle(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
  }
}
handle(buf + dec.decode());
process.exit(exit);
