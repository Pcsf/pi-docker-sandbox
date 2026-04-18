# PI Docker Sandbox

A sandboxed Docker environment for the [PI coding agent](https://github.com/badlogic/pi-mono).

## Features

- **Filesystem isolation** — PI can only access explicitly mounted directories
- **Minimal toolset** — `git`, `jq`, `node`, `npm`, `ripgrep`, and `octave` preinstalled
- **Non-root execution** — runs as unprivileged `pi` user
- **Security hardening** — dropped capabilities, no-new-privileges, read-only rootfs
- **OAuth login support** — use your Anthropic/GitHub/Google subscription
- **Local LLM support** — connect to Ollama/LM Studio on the host
- **Host tool mounting** — expose simple host binaries (python, ghdl, emacs, …) to the container via `--tools`
- **Extension development** — mount your extensions directory for seamless dev
- **Arch-based base image** — matches the glibc/ABI of an Arch host, so mounted host binaries load without version skew

## Quick Start

### 1. Build the image

```bash
cd pi-sandbox
docker build -t pi-sandbox .
```

### 2. First-time OAuth login

```bash
./pi-docker --login
# Inside PI, run /login and select your provider
# Open the displayed URL in your host browser
# After login completes, exit PI (ctrl+c twice)
```

### 3. Run PI in a project

```bash
cd ~/my-project
pi-docker
```

## Usage

```bash
pi-docker                              # Run in current directory
pi-docker ~/extra-repo                 # Mount additional repo under /repos/extra-repo
pi-docker ~/repo1 ~/repo2              # Mount multiple extra directories
pi-docker --login                      # OAuth login mode
pi-docker --build                      # Rebuild image, then run
pi-docker --tools python,ghdl          # Mount individual host tools
pi-docker --tools emacs ~/extra-repo   # Combine with other options
pi-docker --host-apps                  # Full host application access (write jail)
pi-docker --host-apps --local          # Host apps + local LLMs
pi-docker -- --provider anthropic      # Pass flags to PI after --
```

## Setup

### Prerequisites

- Docker installed and running
- `~/.pi/agent/` directory exists (created by previous PI installation)

### Skills

Skills are mounted from a local directory (default `~/pi-skills`). Set a custom path:

```bash
# Add to your .zshrc / .bashrc:
export PI_SKILLS_DIR=~/path/to/your/skills
```

On the host, `~/.pi/agent/skills` is a symlink to the same repo. Inside the container, the directory is bind-mounted directly.

### Extensions

Set the extensions directory (default is `~/pi-extensions`):

```bash
# Add to your .zshrc / .bashrc:
export PI_EXTENSIONS_DIR=~/path/to/your/extensions
```

### Host Tools

Mount host-installed tools into the container so the LLM can run them (e.g. to test code):

```bash
pi-docker --tools python,ghdl,octave
```

Each tool is auto-discovered via `which`, its shared-library dependencies are resolved via `ldd`, and sibling binaries / RPATH directories are pulled in automatically. Everything is mounted read-only into an isolated `/opt/host-tools/` tree. The entrypoint generates wrapper scripts that invoke the host's dynamic linker with `--library-path`, and exports `LD_LIBRARY_PATH` so child processes launched by `exec` (common in multi-binary tools like Octave) also find the right libs.

**How it works:**
- Tool binary → `/opt/host-tools/real/<name>` (read-only), wrapped by a script in `/opt/host-tools/bin/<name>` that's put on `PATH`.
- **Sibling binaries** (same directory, shared prefix — e.g. `octave-cli-11.1.0`, `octave-config-*`) → bind-mounted at their literal host paths so hardcoded `execve("/usr/bin/<sibling>")` calls resolve.
- **Non-glibc shared libs** → `/opt/host-tools/lib/<SONAME>` (e.g. `libfreetype.so.6`), exposed to child processes via `LD_LIBRARY_PATH`. Glibc family (`libc`, `libm`, `libpthread`, …) is intentionally excluded from this dir to avoid mixing host/container glibc.
- **Tool-specific lib subdirs** (anything that isn't a system lib dir like `/usr/lib`) → bind-mounted at their literal paths so `RPATH`/`RUNPATH` lookups succeed. `RPATH` is also read directly via `readelf` when available.
- **Runtime data** (`fonts`, `icons`, locale files, Octave's `.m` scripts, Python stdlib, …) → the host's `/usr/{bin,sbin,lib,lib32,lib64,libexec,share,include}` are bind-mounted at `/opt/host-tools/host-usr/*` (read-only). `XDG_DATA_DIRS` and `PATH` in the wrapper point at these. `/usr/local` and `/usr/src` are **not** mounted, to avoid exposing user-installed scripts that may embed secrets.

**Limitations:**
- Tool names must match what `which` finds on the host.
- If a tool expects writable config under `/usr/local` or spawns an unrelated binary via absolute path (outside its own sibling prefix), you may need to add it to `--tools` explicitly.
- Binaries from a host with *newer* glibc than the container's will fail with `GLIBC_x.xx not found`. The default Arch base image matches an Arch host's glibc, but if your host runs something newer, rebuild the image (`pi-docker --build`) so the container picks up the latest `archlinux:latest`.

**When *not* to use `--tools`:**

For applications that carry their own runtime ecosystem — package managers, plugin systems, autoload scripts, version-coupled data files — mounting the host binary is fragile. Octave is the canonical example: its `PKG_ADD` bootstrap calls builtins that only resolve under the full installed environment, which the mount-and-wrap approach can't recreate.

**For such apps, either install them directly in the container's `Dockerfile` (`octave` is preinstalled for this reason), or use `--host-apps` (see below) which exposes every host-installed app at once.**

Rule of thumb:
- **Standalone binaries** (`jq`, `ghdl`, small Python CLIs): `--tools` is fine.
- **Apps with their own package/plugin system**: add to `Dockerfile`, or use `--host-apps`.

### Host Apps Mode (`--host-apps`)

A looser sandbox that gives the container **full read access to every host-installed application**, while keeping writes confined. The sandbox becomes a *write jail* rather than a filesystem sandbox — similar to `distrobox` or Fedora's `toolbox`.

```bash
pi-docker --host-apps            # any host binary just works
pi-docker --host-apps --local    # + local LLMs
```

**What it mounts (read-only, at literal paths, overlaying the container):**
- `/usr/bin`, `/usr/sbin`, `/usr/lib`, `/usr/lib32`, `/usr/lib64`, `/usr/libexec`, `/usr/share`, `/usr/include`

**Not mounted** (kept container-local or excluded):
- `/usr/local`, `/usr/src` — may contain user-installed scripts with hardcoded secrets
- `/etc`, `/opt`, `/var`, `/home/<you>` — container has its own
- `$HOME/.ssh`, `$HOME/.aws`, etc. — never exposed unless you explicitly mount them as an extra path

**What stays writable:**
- `/workspace`, `/home/pi/.pi/`, `/tmp` (tmpfs)

**What stays enforced (same as default mode):**
- `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only` rootfs
- Non-root `pi` user (UID 1000)
- Bridge network (or host network only with `--local`/`--login`)

**Tradeoffs:**
- **+** Every host app works out of the box: `octave`, `ghdl`, `vivado`, `matlab` (if in `/usr`), etc.
- **+** No `--tools` maintenance, no wrapper scripts, no library dance
- **−** The agent can *read* anything under host `/usr`. Most of `/usr/share` is package data, but still worth being aware of.
- **−** Writes are still blocked, but reads could go out via network (use with `--local` scoped to localhost services if you care).

**Requires:** host must have `node` somewhere on `/usr/bin` (the container's PI agent at `/opt/pi-agent/bin/pi` has a `#!/usr/bin/env node` shebang). Every Arch machine with `nodejs` installed satisfies this.

**When to prefer `--host-apps` over `--tools` + Dockerfile installs:**
- You have many host tools you'd otherwise have to enumerate in `--tools`
- You trust the agent's scope for the session and want frictionless access
- Tools depend on host-side config under `/usr/share` (fonts, themes, plugin packs)

**When to prefer the default sandbox:**
- You're running a task you don't fully trust
- You want the tightest possible read surface
- You're debugging and want reproducible, image-pinned tool versions

### Local LLMs (Ollama / LM Studio)

Use the `--local` flag to enable host networking so the container can reach local LLM servers. This is required because servers like LM Studio typically bind to `127.0.0.1` only, which is unreachable from Docker's default bridge network.

```bash
pi-docker --local                      # local LLMs only
pi-docker --local --tools python       # local LLMs + host tools
```

Configure `~/.pi/agent/models.json` with `localhost` URLs as usual:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" }
      ]
    },
    "lm-studio": {
      "baseUrl": "http://localhost:1234/v1",
      "api": "openai-completions",
      "apiKey": "lm-studio",
      "models": [
        { "id": "your-model-name" }
      ]
    }
  }
}
```

### Installation (symlink to PATH)

```bash
ln -s "$(pwd)/pi-docker" ~/.local/bin/pi-docker
```

## Container Paths

| Host Path | Container Path | Mode | Type |
|---|---|---|---|
| Current directory | `/workspace` | read-write | bind mount |
| `~/.pi/agent/` | `/home/pi/.pi/agent/` | read-write | bind mount |
| Skills dir | `/home/pi/.pi/agent/skills/` | read-write | bind mount |
| Extensions dir | `/home/pi/.pi/agent/extensions/` | read-write | bind mount |
| Extra paths | `/repos/<dirname>` | read-write | bind mount |
| npm packages | `/home/pi/.npm-global/` | read-write | named volume |
| npm cache | `/home/pi/.npm/` | read-write | named volume |
| Host tools (binary) — `--tools` | `/opt/host-tools/real/<name>` | read-only | bind mount |
| Host tools (non-glibc libs) — `--tools` | `/opt/host-tools/lib/` | read-only | bind mount |
| Host tools (siblings, RPATH dirs) — `--tools` | original host path | read-only | bind mount |
| Host `/usr/{bin,lib,…}` — `--tools` | `/opt/host-tools/host-usr/` | read-only | bind mount |
| Host tools (wrappers) — `--tools` | `/opt/host-tools/bin/` | read-write | tmpfs |
| Host `/usr/{bin,sbin,lib,lib32,lib64,libexec,share,include}` — `--host-apps` | same path | read-only | bind mount |
| `/tmp` | `/tmp` | read-write | tmpfs |
| `~/.cache` | `/home/pi/.cache/` | read-write | tmpfs |

Named volumes (`pi-sandbox-npm-global`, `pi-sandbox-npm-cache`) persist between runs so extensions only install once.

## Updating PI

1. Edit `Dockerfile` — change the version number in the `npm install -g @mariozechner/pi-coding-agent@…` line
2. Rebuild: `pi-docker --build` or `docker build -t pi-sandbox .`
3. Clear cached extensions: `docker volume rm pi-sandbox-npm-global pi-sandbox-npm-cache`
4. First run after update will reinstall extensions into the volumes

Because the base image is `archlinux:latest` (rolling), a rebuild also refreshes the container's glibc and system libs. If a host binary starts failing with `GLIBC_x.xx not found` after a host system update, rerun `pi-docker --build` to resync.

## Uninstalling Host PI

After verifying the container works:

```bash
npm uninstall -g @mariozechner/pi-coding-agent
npm uninstall -g @aliou/pi-extension-dev @plannotator/pi-extension @tmustier/pi-skill-creator pi-planning-with-files pi-subagents
```

Keep `~/.pi/agent/auth.json` and `models.json` — the container uses them.

## Security

- Runs as non-root user (`pi`, UID 1000)
- All Linux capabilities dropped (`--cap-drop=ALL`)
- No privilege escalation (`--security-opt=no-new-privileges`)
- Read-only root filesystem (`--read-only`)
- tmpfs for `/tmp` (no persistent writes outside mounts)
- No `--network host` in normal mode (only in `--login` mode)
