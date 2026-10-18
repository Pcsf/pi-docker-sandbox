# FPGA job broker (`--fpga`)

Vendor FPGA toolchains usually run in their own Docker images, started by a
launcher script. Giving the sandbox the Docker socket so it can call those
launchers would give it the host: whoever can talk to the socket can start a
container that mounts anything. The broker runs those jobs for the sandbox
without handing it the socket.

```
pi container                          host
  fpga-run vivado -- make impl
    |  POST /run {profile, cwd, script, options}
    +--> /run/pi-broker/broker.sock --> broker.ts
                                          - profile must exist in the config
                                          - options must be in its allowlist
                                          - cwd must resolve (symlinks too)
                                            inside a directory this session
                                            mounted
                                          -> runs the profile's launcher in
                                             that host directory, script on
                                             stdin
    <-- streamed stdout/stderr, exit code ------+
```

`pi-docker --fpga` starts one broker per session, tells it the exact
container-to-host path map it mounts (`/workspace`, `/repos/<name>`), mounts
only the socket directory and the `fpga-run` client, and stops the broker when
the session ends. The broker also exits if the session is killed outright.

The script is not restricted: it runs inside the job container the launcher
creates, and that container is the boundary. The broker controls *which*
launcher runs and *where*; the launcher controls what the job container can
see. Launchers used here should therefore offer a batch mode with no display,
no `--privileged`, toolchains mounted read-only and devices only on request.

## Configuration

`~/.config/pi-sandbox/broker.json` (override with `PI_BROKER_CONFIG`). It stays
on the host and is never mounted into the container.

```json
{
  "profiles": {
    "vivado": {
      "launcher": "~/fpga/xilinx-dev-env/vivado_docker.sh",
      "args": ["--batch"],
      "options": { "frozen-time": ["-f"], "usb": ["--usb"] }
    },
    "altera": {
      "launcher": "~/fpga/altera-dev-env/altera_docker.sh",
      "args": ["--batch"],
      "options": { "usb": ["--usb"] }
    }
  }
}
```

- `launcher`: absolute path (or `~/`), must be executable.
- `args`: always passed.
- `options`: names the sandbox may ask for, each mapped to the launcher flags
  it adds. Anything else is refused.

## Use from inside the session

```
fpga-run [-o OPTION]... PROFILE -- COMMAND [ARG]...
fpga-run [-o OPTION]... PROFILE < script.sh
```

It runs in the current directory and exits with the job's exit code; a refusal
exits 2 and names the allowed values.

```
fpga-run altera -- quartus_sh --version
fpga-run -o frozen-time vivado -- make impl
```

## Dependencies

- `bun` on the host (runs `broker.ts`); the image already ships it for the
  client.
- The launchers and toolchain images named in the config.

Every request is logged to `~/.local/state/pi-sandbox/broker.log`.

## Tests

```
cd broker && bun test
```
