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

| Host requirement                     | Implementation                                                           |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `ora/register` with methods + emits  | `runAgentPlugin` → SDK `defineAgent`: 3 methods, `agent/acp` emit        |
| `agent/start`                        | `handlers/lifecycle.ts` spawns `opencode acp --cwd <cwd>`                |
| `agent/stop`                         | kills the CLI, keeps this process alive so a later start can respawn it  |
| `agent/listModels`                   | `handlers/models.ts`: `opencode models`, cached, curated fallback        |
| `agent/acp` (both directions)        | `handlers/acp.ts` + `services/opencode-client.ts`, payload never parsed  |
| CLI absent → `-32001`                | `services/command.ts` throws `PluginMethodError(AGENT_NOT_INSTALLED, …)` |
| one plugin = one agent = one process | a single plugin instance owning a single `OpenCodeClient`                |

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
    opencode-client.ts    spawns and owns `opencode acp`, both stdio pumps
    command.ts            binary resolution, spawn candidates, not-found mapping
    ndjson.ts             NDJSON line codec for the CLI's stdio
tests/host-simulator.ts   drives this plugin the way the Ora host does
```

Every module imports `@ora-space/plugin-sdk` as a fully qualified
`jsr:@ora-space/plugin-sdk@0.1.3` specifier rather than a bare one, because Ora
launches the plugin with `deno run --no-prompt` and no import map: a bare
specifier would have nothing to resolve it against. A `jsr:` specifier needs no
import map — Deno resolves it directly against the JSR registry and caches it
locally — so this still works under Ora's launch flags. Bump the pinned version
in every import together when the SDK changes.

## Requirements

- The OpenCode CLI on PATH (`opencode`, or the `opencode.cmd` shim npm installs
  on Windows). Pin an explicit binary with `ORA_OPENCODE_BIN`.
- Deno, which Ora provides for plugin processes.

Ora launches agent plugins with
`--allow-run --allow-read --allow-env
--allow-net`; this plugin needs all four
(spawn the CLI, resolve it, read `ORA_OPENCODE_BIN`, let the CLI reach its
providers).

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
