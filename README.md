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

This plugin needs **Ora Desktop 0.7.0 or later**: the Desktop that hands
sessions their Skills in `session/new` and asks `agent/discover`. An older
Desktop still starts the agent and lists its models through `agent/list_models`,
but has no commands before the first message and — since this plugin no longer
declares the Skill Effect Resource older Desktops relied on — gives OpenCode no
Skills. Upgrade Desktop before this plugin.

The requirement is stated here and in the release notes rather than in
`orax.toml`: Ora settled on release order and release notes, with no manifest
field and no marketplace gate, because an older Desktop would not read a new
field anyway.

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

This prerelease pins OpenCode **2.0.32** from the official `@opencode/cli` npm
distribution. `bundle.config.ts` selects an explicit version and platform
packages; `deno task sync` records their tarball URLs and SHA-512 integrity in
`upstream.lock.json`. Packaging verifies integrity before extracting
`package/bin/opencode[.exe]`; it never resolves a newer version. The GitHub
Release source remains supported for configurations without `npm`.

```
deno task sync --check
deno task build
deno task package --tag v0.7.0-opencode2.1 --repo ora-space/opencode-agent
```

This produces one `.orax` package per target platform, with the matching
OpenCode CLI bundled inside. npm packaging downloads from `registry.npmjs.org`;
GitHub-based configurations additionally require `gh`. Generated download URLs
describe a future release; building packages does not upload or publish them.

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
`deno test scripts/upstream.test.ts` checks archive integrity rejection.

To exercise the bundled entrypoint as well as the CLI, extract a complete
package to a separate directory and run:

```
deno task simulate --package-root /absolute/extracted-package --cwd /absolute/workspace
```

The simulator fails on ACP error responses and covers startup, discovery (models
and commands), and stop. It does not install the package into a user's Ora
profile or replace the marketplace version.

### SDK

The plugin imports `@ora-space/plugin-sdk` from its published JSR package. The
version is pinned in `deno.json` and resolved by the committed `deno.lock`.

## Discovery

OpenCode has no way to list its models outside a session: its real catalog — the
display names, the grouping, and which model is currently selected — is the
session configuration the CLI computes from your providers and config file, and
it reports its commands only after a session exists. So when Ora asks this
plugin (`agent/discover`) what a workspace offers, the plugin starts a second,
throwaway `opencode acp` in that directory, runs `initialize` → `session/new` on
it, reads the model selector out of the answer, and — when Ora wants commands —
waits for the session's first command report. It then deletes the probe session
if the CLI says it can, and kills the process.

- The wait for commands ends at the probe session's own first report (one that
  arrives before `session/new` answers counts too; a report about another
  session does not), at Ora's cap of two seconds, or where the cleanup reserve
  before Ora's deadline begins. No report leaves the commands out — unknown —
  which Ora tells apart from an empty list.
- The probe uses the same Skill input as a session, and no MCP servers.
- Deleting the probe session gets at most the cleanup reserve, ending a second
  before Ora's deadline: a CLI that never answers the delete is still killed,
  and the models and commands already read are still returned in time.
- A models-only question (and every `agent/list_models`) does not wait for
  commands. On a platform route the frozen model is answered without a probe,
  and without commands.

It has to be a separate process. The connection Ora holds is one Ora owns both
ends of: a request injected into it would return its answer down Ora's pipe, and
the client capabilities Ora declares in its own `initialize` are what decide
whether OpenCode reports a model selector at all.

Answers are reused for five minutes, in memory only, for the very same input:
the workspace, whether commands were wanted and, when they were, the Skills
including their `revision`, which Ora changes whenever the Skills do. A picker
that re-renders does not restart the CLI, a model that appears after a provider
login shows up the next time the picker is opened, and a Skill change is never
answered with commands from before it.

## Known limits

- OpenCode v2 supports `session/delete`, which model discovery uses to remove
  its temporary session. Older CLI overrides without that capability leave an
  empty session behind.
- V2 runs as `opencode acp` with the host-provided working directory; it does
  not accept the v1 `--cwd` flag.
- The plugin transparently forwards child-session metadata. Complete child
  details after reload depend on the host preserving that metadata in history.
  This prerelease does not implement host history or UI changes and does not
  enable the separate `opencode/child-session-updates` extension.
- Nested subagents require OpenCode's `experimental.subagent_depth` to permit
  the requested depth. The plugin does not change the user's depth policy.
- Interactive question forms require an ACP client supporting the corresponding
  elicitation capability. With no such capability, OpenCode reports that the
  question could not be shown; ordinary permission requests remain separate.
- Killing the CLI on agent stop is best effort; Ora retains process-tree reaping
  as a backstop.
