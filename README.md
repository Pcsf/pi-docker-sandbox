# PI Docker Sandbox

A sandboxed Docker environment for the [PI coding agent](https://github.com/badlogic/pi-mono).

## Features

- **Filesystem isolation** — PI can only access explicitly mounted directories
- **Minimal toolset** — only `git`, `jq`, `node`, and `npm` available
- **Non-root execution** — runs as unprivileged `pi` user
- **Security hardening** — dropped capabilities, no-new-privileges, read-only rootfs
- **OAuth login support** — use your Anthropic/GitHub/Google subscription
- **Local LLM support** — connect to Ollama/LM Studio on the host
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
pi-docker -- --provider anthropic      # Pass flags to PI after --
```

## Setup

### Prerequisites

- Docker installed and running
- `~/.pi/agent/` directory exists (created by previous PI installation)

### Extensions

Set the extensions directory (default is `~/pi-extensions`):

```bash
# Add to your .zshrc / .bashrc:
export PI_EXTENSIONS_DIR=~/Documents/10-repos/11-gitRepo/pi-extensions
```

### Local LLMs (Ollama / LM Studio)

Edit `~/.pi/agent/models.json` to use `host.docker.internal` instead of `localhost`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://host.docker.internal:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "llama3.1:8b" }
      ]
    },
    "lm-studio": {
      "baseUrl": "http://host.docker.internal:1234/v1",
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

| Host Path | Container Path | Mode |
|---|---|---|
| Current directory | `/workspace` | read-write |
| `~/.pi/agent/auth.json` | `/home/pi/.pi/agent/auth.json` | read-write |
| `~/.pi/agent/models.json` | `/home/pi/.pi/agent/models.json` | read-only |
| `~/pi-extensions/` | `/home/pi/.pi/agent/extensions/` | read-write |
| Extra paths | `/repos/<dirname>` | read-write |

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
