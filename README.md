# ora-space.opencode

An **agent plugin** for Ora that publishes [OpenCode](https://opencode.ai) as a
selectable agent. The plugin runs `opencode acp` (OpenCode's native
[Agent Client Protocol](https://agentclientprotocol.com) mode) as a child
process and bridges it to Ora as a pure ACP pipe.

Nothing in Ora is hardcoded for this plugin: it is discovered from the installed
plugin directory, validated from `package.json`, and launched as an ordinary
agent provider. Deleting the directory removes the agent.

```
┌────────────────────────── Ora host (Rust) ───────────────────────────┐
│  agent_runtime → plugin_agent                                        │
│    invoke : agent/start · agent/stop · agent/listModels              │
│    notify : agent/acp (bidirectional, payload never parsed)          │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ stdio, 4-byte length + 0x01 + JSON-RPC
                             v
┌──────────────────── this plugin (Deno process) ──────────────────────┐
│  src/main.ts        OpenCodeAgentPlugin extends AgentPlugin          │
│  src/handlers/*     one module per registered API                    │
│  src/services/*     OpenCode CLI ownership, NDJSON framing           │
└────────────────────────────┬─────────────────────────────────────────┘
                             │ NDJSON, one JSON-RPC object per line
                             v
                       opencode acp (ACP protocolVersion 1)
```

## Contract mapping

| Host requirement                     | Implementation                                                             |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `ora/register` with methods + emits  | `runAgentPlugin` → SDK `defineAgent`: 3 methods, `agent/acp` emit          |
| `agent/start`                        | `handlers/lifecycle.ts` spawns `opencode acp --cwd <cwd>`                  |
| `agent/stop`                         | kills the CLI, keeps this process alive so a later start can respawn it    |
| `agent/listModels`                   | `handlers/models.ts`: `opencode models`, cached, curated fallback          |
| `agent/acp` (both directions)        | `handlers/acp.ts` + `services/opencode-client.ts`, payload never parsed    |
| `ORA_OPENCODE_BIN` absent → `-32001` | `services/command.ts`; a broken _bundled_ binary is a real failure instead |
| one plugin = one agent = one process | a single plugin instance owning a single `OpenCodeClient`                  |

## API registration architecture

The plugin follows the class-based organization from Ora's API registration
guide: every registered API is a method on a base class, and the entrypoint only
mounts handler modules onto it.

- `src/base/agent-plugin.ts` declares `abstract class AgentPlugin`. Required
  APIs are `abstract`, so an incomplete plugin fails to compile; optional APIs
  (`onStop`, `onActivate`, `onDeactivate`) ship default implementations.
- `runAgentPlugin` flattens the instance into a wire-name keyed dispatch table
  by walking its prototype chain, so dispatch is a single map lookup and a
  handler mounted as a field (`override onStart = …`) is found exactly like a
  method.
- `AGENT_METHOD_ROUTES` / `AGENT_NOTIFICATION_ROUTES` hold the class-method →
  JSON-RPC name mapping explicitly, because the host contract fixes the wire
  names and deriving them from method names would silently break on a rename.
- Adding an API later means adding one method to the base class, one route
  entry, and one handler module — the entrypoint does not grow.

## Layout

```
package.json              Ora manifest (ora.kind = "agent", ora.contributes.agent)
deno.json                 developer tasks only; Ora never reads it
src/
  main.ts                 entrypoint: mounts handlers onto the base class
  base/agent-plugin.ts    AgentPlugin base class + dispatch table + runAgentPlugin
  handlers/
    lifecycle.ts          agent/start, agent/stop
    models.ts             agent/listModels
    acp.ts                agent/acp (host → CLI)
  services/
    opencode-client.ts    owns the `opencode acp` child, both stdio pumps
    command.ts            which program to spawn, and how a failure is classified
    bundled-binary.ts     where the bundled CLI lives inside the package
    ndjson.ts             NDJSON line codec for the CLI's stdio
bundle.config.ts          which upstream CLI is bundled, and its asset per target
scripts/package.ts        builds one .orax per target; plugin-agnostic
tests/host-simulator.ts   drives this plugin the way the Ora host does
```

`bundle.config.ts` is the only plugin-specific half of the release pipeline.
`scripts/package.ts` and `.github/workflows/release.yml` name no CLI and are
meant to be copied to another agent plugin unchanged, with only that config
rewritten. `src/services/bundled-binary.ts` is the single source of truth for
the in-package binary path, shared by the runtime spawn and the packaging step
so the two cannot drift.

Run the packaging locally with:

```
deno task build
deno task package --tag v0.2.4 --repo ora-space/opencode-agent
```

`gh` is the only external tool required — archives are read and written
in-process, so this works the same on a maintainer's machine as it does in CI.

Every module imports `@ora-space/plugin-sdk` as a fully qualified
`jsr:@ora-space/plugin-sdk@0.1.3` specifier rather than a bare one, because Ora
launches the plugin with `deno run --no-prompt` and no import map: a bare
specifier would have nothing to resolve it against. A `jsr:` specifier needs no
import map — Deno resolves it directly against the JSR registry and caches it
locally — so this still works under Ora's launch flags. Bump the pinned version
in every import together when the SDK changes.

## Requirements

- Nothing. The OpenCode CLI ships **inside** this package under
  `assets/bin/opencode[.exe]`, so there is no separate install step and no PATH
  lookup. Releases are built one `.orax` per target triple, and the package
  self-declares its target in `[artifact]` so Ora refuses a package built for
  another machine rather than landing a binary that cannot run.
- Deno, which Ora provides for plugin processes.

`ORA_OPENCODE_BIN` still overrides the bundled binary with an explicit path,
which is how you drive a locally built OpenCode: a developer's own build has no
way into an installed package. Only that path reports `agent_not_installed` when
it is missing — a bundled binary that will not resolve means the package is
broken or was built for the wrong target, which fails identically on every retry
and so must surface rather than be retried quietly.

The plugin itself no longer spawns anything: it asks the host to spawn the
bundled CLI by package-relative path (`packageCommand`), because a plugin is
told no host path and cannot reliably compute one. Ora launches agent plugins
with `--allow-run --allow-read --allow-env --allow-net`; of those this plugin
now only uses `--allow-env` (`ORA_OPENCODE_BIN`) and leaves the CLI's own
network access to the CLI.

## Installation and discovery

Ora discovers plugin packages as the direct children of
`<ORA_DATA_DIR>/plugins/`, so that directory must resolve to the folder holding
this package. On Windows, a junction keeps the packages in one place:

```powershell
cmd /c mklink /J "<ORA_DATA_DIR>\plugins" "%USERPROFILE%\.ora\plugins\installed"
```

Development runs (`task run:desktop`) set `ORA_DATA_DIR` to the repository's
`.data` directory, so the junction goes at `<repo>/.data/plugins`. A packaged
build uses Tauri's application data directory instead.

Every direct child of that directory must be a valid package: a folder without a
`package.json` is reported as a discovery issue.

## Verification

`deno task simulate` runs `tests/host-simulator.ts`, which speaks Ora's binary
frame protocol to a freshly launched plugin process against the real CLI:

```
ok: register {"methods":["agent/start","agent/stop","agent/listModels"],"emits":["agent/acp"]}
ok: agent/start {"protocol":"acp","acpVersion":1}
ok: initialize {"protocolVersion":1,"agentCapabilities":{…}}
ok: session/new {"sessionId":"ses_…","configOptions":[…]}
[host] << {"method":"agent/acp",…}          # streamed session/update forwarded back
ok: listModels 11 models, first {"id":"opencode/big-pickle",…}
ok: agent/stop
plugin exited with code 0
```

`deno task check` type checks and `deno task lint` lints the same sources.

## Known limits

- `agent/start` receives the host's home directory as `cwd`; per-session working
  directories travel in ACP `session/new`, which this plugin passes through.
- The model list is cached for the process lifetime, so models that appear after
  a provider login need a plugin restart.
- When the CLI exits on its own the plugin logs it and lets the host observe a
  stalled connection; the contract has no `agent/exited` notification yet.
- Killing the CLI on `agent/stop` is best effort; Ora retains process-tree
  reaping.
