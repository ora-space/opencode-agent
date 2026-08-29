# ora-space.opencode

An **agent plugin** for [Ora](https://github.com/ora-space) that adds
[OpenCode](https://opencode.ai) as a selectable agent. Once installed, OpenCode
shows up in Ora's agent picker like any other agent — pick it, and your
conversation runs against the OpenCode CLI through its native
[Agent Client Protocol](https://agentclientprotocol.com) mode (`opencode acp`).

## What it does

- Publishes OpenCode as an agent inside Ora, alongside any other agent plugins
  you have installed.
- Starts and stops the OpenCode CLI automatically as you switch agents — nothing
  to run by hand.
- Streams OpenCode's models, sessions, and responses straight through to Ora's
  UI via ACP, including the in-session model picker.
- Materializes Ora's complete HTTP MCP snapshot into the Workspace-local,
  exclusively managed `.opencode/opencode.json` document. OpenCode 0.3.0 does
  not advertise stdio MCP support, so the Host skips those MCPs without blocking
  supported HTTP servers.
- Ships with the OpenCode CLI bundled inside the package, so there is nothing
  else to install.

## Requirements

- Nothing beyond Ora itself. The OpenCode CLI is bundled inside this package
  under `assets/bin/opencode[.exe]` — no separate install, no `PATH` lookup.
  Each release is built per platform, and the package refuses to run on a
  machine it wasn't built for rather than risk launching a binary that can't
  execute.
- If you'd rather run your own build of OpenCode instead of the bundled one, set
  `ORA_OPENCODE_BIN` to its full path.

## Installing

Grab the latest `.orax` package from this repository's
[Releases](../../releases) page, or build one yourself (see below), and drop it
into Ora's plugins directory (`<ORA_DATA_DIR>/plugins/`) — Ora discovers any
folder there with a `package.json` automatically. Deleting the folder removes
the agent again; there's no other install step.

On Windows, if you keep your installed plugins elsewhere, a junction can point
Ora's plugins directory at them:

```powershell
cmd /c mklink /J "<ORA_DATA_DIR>\plugins" "%USERPROFILE%\.ora\plugins\installed"
```

## Building from source

```
deno task build
deno task package --tag v0.3.0 --repo ora-space/opencode-agent
```

This produces one `.orax` package per target platform, with the matching
OpenCode CLI bundled inside. `gh` is the only external tool required.

To drive the plugin end-to-end the way Ora's host does, stage the bundled CLI
where an installed package would have it, then run the simulator:

```
# macOS / Linux
unzip -o dist/packages/*-<your-triple>.orax 'assets/bin/*' -d .
chmod +x assets/bin/opencode

# Windows
unzip -o dist/packages/*-x86_64-pc-windows-msvc.orax 'assets/bin/*' -d .

deno task simulate
```

The simulator resolves `packageCommand` against the repository root, so it runs
the binary under `assets/bin/` — never one on your `PATH`. That directory is
git-ignored and is only needed for this.

`deno task check` type checks and `deno task lint` lints the sources.
`deno task test` exercises MCP materialization in temporary Git and non-Git
Workspaces.

## Managed MCP configuration

Ora-generated MCP configuration is intentionally separate from user-owned
OpenCode configuration. The plugin never modifies project-root `opencode.json`
or `opencode.jsonc`. It writes only `.opencode/opencode.json`, and only when its
private applied/prepared fingerprint ledger proves ownership; a pre-existing or
externally changed file is preserved as a blocking conflict.

In a Git Workspace, only `/.opencode/opencode.json` is added to the repository's
local exclude file. The plugin does not touch `.gitignore` or ignore the
`.opencode` directory, so the neighboring Skill surface remains visible. The
managed document is atomically replaced from a same-directory staging file and
restricted to the current OS account because protocol v1 may contain resolved
plaintext headers. Root configuration collisions, tracked managed paths, Git
failures, and permission failures leave the previous committed document
unchanged.

## Known limits

- The model list is cached for the process lifetime, so models that appear after
  a provider login need a plugin restart.
- Killing the CLI on agent stop is best effort; Ora retains process-tree reaping
  as a backstop.
