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
- Streams OpenCode's sessions and responses straight through to Ora's UI via
  ACP, including the in-session model picker, and answers Ora's pre-session
  model list from OpenCode itself (see [Model discovery](#model-discovery)).
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

### Host requirement

This plugin needs an Ora that sends the workspace `cwd` with
`agent/list_models`. Without it there is no directory to discover models for,
and the plugin answers `-32602` naming the missing parameter rather than probing
against nothing.

That requirement is deliberately **not** declared in `orax.toml`, even though
the schema has the right field for it:

```toml
[dependencies]
ora = ">= x.y.z"
```

Ora parses and validates that table (only `ora` is accepted in it), so it is
where a host requirement belongs — but the host version carrying the parameter
does not exist yet. Ora is at 0.1.0 and the parameter is an unreleased change,
so any number written here today would either be false or vacuous, and a
requirement no host satisfies would make the plugin uninstallable the moment Ora
starts enforcing the field. Fill it in once there is a real host version to
name.

Note that the plugin SDK's version and Ora's are separate lines. This plugin
builds against SDK 0.9.0; that is not an Ora version. The `package.json` this
repository used to carry declared `engines.ora >= 0.8.0` — an SDK version in a
host-version field, in a file no Ora release has ever read —
`scripts/package.ts` has never staged it into a `.orax`. It has been removed
rather than corrected.

## Installing

Grab the latest `.orax` package from this repository's
[Releases](../../releases) page, or build one yourself (see below), and drop it
into Ora's plugins directory (`<ORA_DATA_DIR>/plugins/`) — Ora discovers any
folder there with an `orax.toml` automatically. Deleting the folder removes the
agent again; there's no other install step.

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

### SDK

The plugin imports `@ora-space/plugin-sdk` from its published JSR package. The
version is pinned in `deno.json` and resolved by the committed `deno.lock`.

## Model discovery

OpenCode has no way to list its models outside a session: its real catalog — the
display names, the grouping, and which model is currently selected — is the
session configuration the CLI computes from your providers and config file. So
when Ora asks this plugin for the models available in a workspace, the plugin
starts a second, throwaway `opencode acp` in that directory, runs `initialize` →
`session/new` on it, reads the model selector out of the answer, deletes the
probe session if the CLI says it can, and kills the process.

It has to be a separate process. The connection Ora holds is one Ora owns both
ends of: a request injected into it would return its answer down Ora's pipe, and
the client capabilities Ora declares in its own `initialize` are what decide
whether OpenCode reports a model selector at all.

Answers are reused for five minutes per workspace, so a picker that re-renders
does not restart the CLI, while a model that appears after a provider login
shows up the next time the picker is opened.

## Known limits

- Each model discovery leaves one empty session behind in OpenCode's own session
  list. OpenCode advertises `session/close`, `session/fork`, `session/list`, and
  `session/resume`, but not `session/delete`, so the probe has nothing to clean
  up with; the five-minute cache is what keeps the count down.
- Killing the CLI on agent stop is best effort; Ora retains process-tree reaping
  as a backstop.

## Project Effects

Ora manages `.opencode/skills` as a Skill Effect Resource. Configured MCP
plugins are not written into `.opencode/opencode.json`; Ora injects them through
ACP `session/new` and `session/load` `mcpServers`, which this plugin forwards
unchanged. Secret values stay in Ora's configuration store and never appear in
Workspace files, logs, or `ORA_MCP_*` environment variables.
