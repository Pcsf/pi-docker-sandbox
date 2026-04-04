# PI Docker Sandbox

A sandboxed Docker environment for the [PI coding agent](https://github.com/badlogic/pi-mono).

## Features

- **Filesystem isolation** — PI can only access explicitly mounted directories
- **Minimal toolset** — only `git`, `jq`, `node`, and `npm` available
- **Non-root execution** — runs as unprivileged `pi` user
- **Security hardening** — dropped capabilities, no-new-privileges, read-only rootfs
- **OAuth login support** — use your Anthropic/GitHub/Google subscription
- **Local LLM support** — connect to Ollama/LM Studio on the host
- **Host tool mounting** — expose host binaries (python, ghdl, emacs, etc.) to the container
- **Extension development** — mount your extensions directory for seamless dev

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
pi-docker ~/repo1 ~/repo2             # Mount multiple extra directories
pi-docker --login                      # OAuth login mode
pi-docker --build                      # Rebuild image, then run
pi-docker --tools python,ghdl          # Mount host tools into container
pi-docker --tools emacs ~/extra-repo   # Combine with other options
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
pi-docker --tools python,ghdl,emacs
```

Each tool is auto-discovered via `which`, and its shared library dependencies are resolved via `ldd`. Everything is mounted into an isolated `/opt/host-tools/` directory with read-only bind mounts. The entrypoint creates wrapper scripts that invoke the host's dynamic linker with `--library-path`, so host and container libraries never mix.

**How it works:**
- Binaries → `/opt/host-tools/real/<name>` (read-only)
- Shared libs → `/opt/host-tools/lib/` (read-only, isolated from container libs)
- Runtime dirs (e.g. Python stdlib) → mounted at original paths
- Wrappers → `/opt/host-tools/bin/` (added to `PATH`)

**Limitations:**
- Tools needing runtime data beyond binary + shared libs may need additional support. Python stdlib is detected automatically; other tools may need `detect_runtime_dirs()` updated in `pi-docker`.
- Tool names must match what `which` finds on the host.

### Local LLMs (Ollama / LM Studio)

Configure `~/.pi/agent/models.json` with `localhost` URLs as usual — the entrypoint automatically rewrites them to `host.docker.internal` at container startup:

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
| Host tools (binary) | `/opt/host-tools/real/<name>` | read-only | bind mount |
| Host tools (libs) | `/opt/host-tools/lib/` | read-only | bind mount |
| Host tools (wrappers) | `/opt/host-tools/bin/` | read-write | tmpfs |
| `/tmp` | `/tmp` | read-write | tmpfs |
| `~/.cache` | `/home/pi/.cache/` | read-write | tmpfs |

Named volumes (`pi-sandbox-npm-global`, `pi-sandbox-npm-cache`) persist between runs so extensions only install once.

## Updating PI

1. Edit `Dockerfile` — change the version number in the `npm install` line
2. Rebuild: `pi-docker --build` or `docker build -t pi-sandbox .`
3. Clear cached extensions: `docker volume rm pi-sandbox-npm-global pi-sandbox-npm-cache`
4. First run after update will reinstall extensions into the volumes

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
