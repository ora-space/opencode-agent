# ora-space.opencode

An **agent plugin** for [Ora](https://github.com/ora-space) that adds
[OpenCode](https://opencode.ai) as a selectable agent. Once installed, OpenCode
shows up in Ora's agent picker like any other agent — pick it, and your
conversation runs against the OpenCode CLI through its native
[Agent Client Protocol](https://agentclientprotocol.com) mode (`opencode acp`).

## What it does

- Publishes OpenCode as an agent inside Ora, alongside any other agent plugins
  you have installed.
- Starts and stops the OpenCode CLI automatically as you switch agents —
  nothing to run by hand.
- Streams OpenCode's models, sessions, and responses straight through to Ora's
  UI via ACP, including the in-session model picker.
- Ships with the OpenCode CLI bundled inside the package, so there is nothing
  else to install.

## Requirements

- Nothing beyond Ora itself. The OpenCode CLI is bundled inside this package
  under `assets/bin/opencode[.exe]` — no separate install, no `PATH` lookup.
  Each release is built per platform, and the package refuses to run on a
  machine it wasn't built for rather than risk launching a binary that can't
  execute.
- If you'd rather run your own build of OpenCode instead of the bundled one,
  set `ORA_OPENCODE_BIN` to its full path.

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
deno task package --tag v0.2.4 --repo ora-space/opencode-agent
```

This produces one `.orax` package per target platform, with the matching
OpenCode CLI bundled inside. `gh` is the only external tool required.

To verify a build works end-to-end against a locally installed OpenCode CLI:

```
deno task simulate
```

`deno task check` type checks and `deno task lint` lints the sources.

## Known limits

- The model list is cached for the process lifetime, so models that appear
  after a provider login need a plugin restart.
- Killing the CLI on agent stop is best effort; Ora retains process-tree
  reaping as a backstop.
