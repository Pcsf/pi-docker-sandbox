import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dir;
let base: string;
let root: string;
let outside: string;
let sock: string;
let marker: string;
let broker: ReturnType<typeof Bun.spawn>;

type Frame = { o?: string; e?: string; exit?: number };

async function post(body: unknown, signal?: AbortSignal) {
  return fetch("http://broker/run", {
    unix: sock,
    method: "POST",
    body: JSON.stringify(body),
    signal,
  } as RequestInit);
}

async function frames(res: Response): Promise<Frame[]> {
  const text = await res.text();
  return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function invoked(): boolean {
  return existsSync(marker);
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "pi-broker-test-"));
  root = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(outside);
  mkdirSync(join(root, "bad\nname"));
  symlinkSync(outside, join(root, "escape"));
  marker = join(base, "invoked");
  sock = join(base, "broker.sock");

  const fake = join(base, "fake-launcher.sh");
  writeFileSync(
    fake,
    `#!/bin/bash
touch "${marker}"
echo "ARGS:$*"
echo "PWD:$PWD"
echo "WORKDIR:$BATCH_WORKDIR"
echo "to-stderr" >&2
script=$(cat)
eval "$script"
`,
  );
  chmodSync(fake, 0o755);

  const config = join(base, "broker.json");
  writeFileSync(
    config,
    JSON.stringify({
      profiles: {
        vivado: { launcher: fake, args: ["--batch"], options: { "frozen-time": ["-f"], usb: ["--usb"] } },
      },
      maxJobs: 1,
    }),
  );

  broker = Bun.spawn(
    ["bun", join(here, "broker.ts"), "--socket", sock, "--config", config, "--map", `/workspace=${root}`],
    { stdout: "inherit", stderr: "inherit" },
  );
  for (let i = 0; i < 50 && !existsSync(sock); i++) await Bun.sleep(100);
  expect(existsSync(sock)).toBe(true);
});

afterAll(() => {
  broker?.kill();
  rmSync(base, { recursive: true, force: true });
});

describe("request validation", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["traversal out of the root", { profile: "vivado", cwd: "/workspace/../etc", script: "true" }],
    ["symlink escaping the root", { profile: "vivado", cwd: "/workspace/escape", script: "true" }],
    ["unmapped container path", { profile: "vivado", cwd: "/home", script: "true" }],
    ["relative cwd", { profile: "vivado", cwd: "workspace", script: "true" }],
    ["prefix lookalike", { profile: "vivado", cwd: "/workspace2", script: "true" }],
    ["missing directory", { profile: "vivado", cwd: "/workspace/nope", script: "true" }],
    ["unknown profile", { profile: "docker", cwd: "/workspace", script: "true" }],
    ["option outside allowlist", { profile: "vivado", cwd: "/workspace", script: "true", options: ["privileged"] }],
    ["inherited object key as option", { profile: "vivado", cwd: "/workspace", script: "true", options: ["toString"] }],
    ["inherited object key as profile", { profile: "constructor", cwd: "/workspace", script: "true" }],
    ["non-string script", { profile: "vivado", cwd: "/workspace", script: 42 }],
    ["control character in the path", { profile: "vivado", cwd: "/workspace/bad\nname", script: "true" }],
  ];
  for (const [name, body] of cases) {
    test(`rejects ${name} and runs nothing`, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(invoked()).toBe(false);
    });
  }

  test("rejects malformed JSON", async () => {
    const res = await fetch("http://broker/run", { unix: sock, method: "POST", body: "{" } as RequestInit);
    expect(res.status).toBe(400);
    expect(invoked()).toBe(false);
  });

  test("rejects an oversized request body", async () => {
    const res = await fetch("http://broker/run", {
      unix: sock,
      method: "POST",
      body: JSON.stringify({ profile: "vivado", cwd: "/workspace", script: "x".repeat(2 << 20) }),
    } as RequestInit).catch(() => null);
    expect(res === null || res.status >= 400).toBe(true);
    expect(invoked()).toBe(false);
  });

  test("rejects other routes", async () => {
    const res = await fetch("http://broker/", { unix: sock } as RequestInit);
    expect(res.status).toBe(404);
  });
});

describe("running a job", () => {
  test("runs in the mapped host directory with fixed args, option flags and the script on stdin", async () => {
    const res = await post({
      profile: "vivado",
      cwd: "/workspace/sub",
      script: "echo hello-from-script",
      options: ["frozen-time"],
    });
    expect(res.status).toBe(200);
    const f = await frames(res);
    const out = f.map((x) => x.o ?? "").join("");
    const err = f.map((x) => x.e ?? "").join("");
    expect(out).toContain("ARGS:--batch -f");
    expect(out).toContain(`PWD:${root}\n`);
    expect(out).toContain("WORKDIR:sub\n");
    expect(out).toContain("hello-from-script");
    expect(err).toContain("to-stderr");
    expect(f.at(-1)).toEqual({ exit: 0 });
  });

  test("returns the job's non-zero exit code", async () => {
    const f = await frames(await post({ profile: "vivado", cwd: "/workspace", script: "exit 3" }));
    expect(f.at(-1)).toEqual({ exit: 3 });
  });

  test("refuses a job beyond maxJobs while one is running", async () => {
    const ctl = new AbortController();
    const first = await post({ profile: "vivado", cwd: "/workspace", script: "echo busy; sleep 30" }, ctl.signal);
    const reader = first.body!.getReader();
    await reader.read();
    const second = await post({ profile: "vivado", cwd: "/workspace", script: "true" });
    expect(second.status).toBe(429);
    ctl.abort();
    await reader.cancel().catch(() => {});
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await Bun.sleep(100);
      const again = await post({ profile: "vivado", cwd: "/workspace", script: "true" });
      ok = again.status === 200;
      if (ok) await again.text();
    }
    expect(ok).toBe(true);
  });

  test("mounts the outermost session root when one mount is nested in another", async () => {
    const nsock = join(base, "nested.sock");
    const b = Bun.spawn(
      ["bun", join(here, "broker.ts"), "--socket", nsock, "--config", join(base, "broker.json"),
       "--map", `/workspace=${root}`, "--map", `/repos/sub=${join(root, "sub")}`],
      { stdout: "inherit", stderr: "inherit" },
    );
    try {
      for (let i = 0; i < 50 && !existsSync(nsock); i++) await Bun.sleep(100);
      const res = await fetch("http://broker/run", {
        unix: nsock,
        method: "POST",
        body: JSON.stringify({ profile: "vivado", cwd: "/repos/sub", script: "true" }),
      } as RequestInit);
      const out = (await frames(res)).map((x) => x.o ?? "").join("");
      expect(out).toContain(`PWD:${root}\n`);
      expect(out).toContain("WORKDIR:sub\n");
    } finally {
      b.kill();
    }
  });

  test("terminates the job when the client disconnects", async () => {
    const pidFile = join(base, "job.pid");
    const ctl = new AbortController();
    const res = await post(
      { profile: "vivado", cwd: "/workspace", script: `echo $$ > "${pidFile}"; echo started; sleep 30` },
      ctl.signal,
    );
    const reader = res.body!.getReader();
    for (let i = 0; i < 50 && !existsSync(pidFile); i++) await Bun.sleep(100);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(0);
    ctl.abort();
    await reader.cancel().catch(() => {});
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      await Bun.sleep(100);
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});

describe("client", () => {
  test("streams output and exits with the job's code", async () => {
    // The client sends its own cwd, so map it to itself for this test.
    const isock = join(base, "identity.sock");
    const config = join(base, "broker.json");
    const b = Bun.spawn(
      ["bun", join(here, "broker.ts"), "--socket", isock, "--config", config, "--map", `${root}=${root}`],
      { stdout: "inherit", stderr: "inherit" },
    );
    try {
      for (let i = 0; i < 50 && !existsSync(isock); i++) await Bun.sleep(100);
      const c = Bun.spawn(["bun", join(here, "fpga-run.ts"), "vivado", "--", "sh", "-c", "echo 'a b'; exit 5"], {
        cwd: join(root, "sub"),
        env: { ...process.env, PI_BROKER_SOCK: isock },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(c.stdout).text();
      expect(await c.exited).toBe(5);
      expect(out).toContain("a b");
      expect(out).toContain(`PWD:${root}\n`);
      expect(out).toContain("WORKDIR:sub\n");
    } finally {
      b.kill();
    }
  });

  test("reports a broker refusal and exits 2", async () => {
    const c = Bun.spawn(["bun", join(here, "fpga-run.ts"), "-o", "privileged", "vivado", "--", "true"], {
      cwd: root,
      env: { ...process.env, PI_BROKER_SOCK: sock },
      stdout: "pipe",
      stderr: "pipe",
    });
    const err = await new Response(c.stderr).text();
    expect(await c.exited).toBe(2);
    expect(err).toContain("privileged");
  });
});

describe("lifetime", () => {
  test("exits and removes its socket when the parent session dies", async () => {
    const psock = join(base, "parent.sock");
    const parent = Bun.spawn(["sleep", "60"]);
    const b = Bun.spawn(
      ["bun", join(here, "broker.ts"), "--socket", psock, "--config", join(base, "broker.json"), "--parent", String(parent.pid), "--map", `/workspace=${root}`],
      { stdout: "inherit", stderr: "inherit" },
    );
    try {
      for (let i = 0; i < 50 && !existsSync(psock); i++) await Bun.sleep(100);
      expect(existsSync(psock)).toBe(true);
      parent.kill("SIGKILL");
      const code = await Promise.race([b.exited, Bun.sleep(6000).then(() => "timeout")]);
      expect(code).toBe(0);
      expect(existsSync(psock)).toBe(false);
    } finally {
      b.kill();
    }
  }, 10000);
});
