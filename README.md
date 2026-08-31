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
- Ships with the OpenCode CLI bundled inside the package, so there is nothing
  else to install.

## Requirements

- Nothing beyond Ora itself. The OpenCode CLI is bundled inside this package
  under `assets/bin/opencode[.exe]` — no separate install, no `PATH` lookup.
  Each release is built per platform, and the package refuses to run on a
  machine it wasn't built for rather than risk launching a binary that can't
  execute.
- A release can also be published without the CLI (see
  [Building from source](#building-from-source)). Such a package installs on
  every platform and runs the `opencode` already on your `PATH`, so you keep
  your own install and its version.
- If you'd rather run your own build of OpenCode instead of the bundled one, set
  `ORA_OPENCODE_BIN` to its full path. It wins over both of the above.

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

`bundle.config.ts` decides which of the two release shapes is built, and it is
the only file to change to switch:

| `cli`              | Produces                               | At runtime                               |
| ------------------ | -------------------------------------- | ---------------------------------------- |
| `"bundled"`        | one `.orax` per declared target triple | runs the CLI inside the package          |
| `"user_installed"` | one `.orax` every host can install     | runs the `opencode` on the user's `PATH` |

Ora's marketplace release carries either per-target artifacts or one universal
artifact, never both, which is why this is one choice per release rather than a
mix. The plugin source is identical for both: it asks the host for its bundled
CLI first and falls back to a `PATH` lookup only when the host answers that this
package carries none — so a bundled package never silently runs some other
OpenCode, and a bundled binary that cannot run is reported as a broken package
instead of being retried forever as a missing CLI.

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
the binary under `assets/bin/`. That directory is git-ignored and is only needed
for this: with nothing staged there, the simulator answers exactly as Ora would
for a package that bundles no CLI, and the run exercises the `PATH` fallback
against your own OpenCode instead.

`deno task check` type checks and `deno task lint` lints the sources.

## Known limits

- The model list is cached for the process lifetime, so models that appear after
  a provider login need a plugin restart.
- Killing the CLI on agent stop is best effort; Ora retains process-tree reaping
  as a backstop.
