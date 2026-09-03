# ora-space.opencode

An Ora **agent plugin**: a Deno process that speaks Ora's binary JSON-RPC
protocol on stdio and bridges `opencode acp` to Ora as an ACP pipe. `README.md`
describes what it does and how to release it; this file records the constraints
that are easy to get wrong and expensive to rediscover.

## This is an agent plugin, and an agent plugin implements the whole SDK contract

**`kind = "agent"` in `orax.toml` is not a label — it is a contract, and a
partial implementation of it fails silently rather than loudly.** Ora validates
the registration handshake and then simply does not use what a plugin did not
declare. There is no warning, no log line, and no error surfaced to the user.

Every API the plugin SDK offers an agent must be served, not just the ones a
feature currently exercises:

| SDK surface                                                                                                                             | Where it is mounted                                     | What is lost by omitting it                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `agent/start` · `agent/stop`                                                                                                            | `handlers/lifecycle.ts`                                 | the agent cannot run at all — these are `abstract`, so this fails to compile |
| `agent/list_models`                                                                                                                     | `handlers/models.ts`                                    | no model picker; also `abstract`                                             |
| `agent/acp` (both directions)                                                                                                           | `handlers/acp.ts` + `services/opencode-client.ts`       | no conversation; also `abstract`                                             |
| **Effect Resources** — `effect/coordinate`, `effect/reactivate`, `effect/verify_ready`, and the `EffectResourceDeclaration` behind them | `handlers/effects.ts`, mounted as `AgentPlugin.effects` | **Skills never appear in the Workspace, with no error anywhere**             |

The Effect row is the one that has actually been shipped broken — in the sibling
`codeagent-agent`, which was byte-for-byte this plugin apart from
`handlers/effects.ts` and its three lines of wiring, and which therefore
accepted every Skill import and wrote nothing to disk. Read the next section
before touching anything about Skills.

## Effects are opt-in, and opting out is invisible

The Skill directory Ora writes into a Workspace exists **only** because this
plugin declares it. The chain is short and every link is a hard gate:

```
handlers/effects.ts  SKILLS_RESOURCE                    ← the declaration
main.ts              override readonly effects = …      ← mounted on the instance
base/agent-plugin.ts defineAgent({ …, effects })        ← handed to the SDK
SDK agent.ts         if (effects !== undefined) { declareEffectResource(…) }
SDK plugin.ts        effectResources omitted from ora/register when the list is empty
```

Miss **any** of those and `ora/register` goes out with no `effectResources`
field at all. From Ora's side this plugin does not consume Skills, so importing
one succeeds, Ora has no Target to project it onto, nothing is written to disk,
and no error is raised, logged, or shown anywhere.

**When a Skill does not appear, check the declaration before debugging
materialization.** The shipped bundle answers it in one command:

```
deno task build && grep -c skill dist/main.js
```

A `0` means the declaration never reached the package.

### What the coordination calls have to promise

Declaring a Resource is also a promise to make its mutation safe, and Ora will
call all three methods:

- **`coordinate`** must raise the new-turn barrier _before_ it waits for running
  turns, not after. A check that only latched on an observed idle moment would
  never find one in a Workspace whose prompts keep arriving; holding first makes
  the set of turns to drain finite, so the wait terminates. It must also release
  the barrier before failing — Ora only reactivates Targets whose coordination
  succeeded, so an abandoned barrier holds its queued prompts for the life of
  the process. The 10-second drain budget exists because Ora allows a plugin
  control call 30 seconds and coordination holds that call open; it must finish
  well inside that rather than wait out a prompt that may legitimately run for
  minutes.
- **`reactivate`** respawns the CLI. **OpenCode scans its Skill directories once
  at startup and never rescans**, so a restart is the only thing that makes an
  edited tree visible — this is not a precaution, it is the mechanism.
- **`verify_ready`** reports readiness by **returning**; a Consumer says "not
  ready" by throwing `-32000`. Returning a payload that says "not ready" would
  be recorded as ready. The proof this plugin can offer is narrow and worth
  keeping honest: a CLI that is up and outside a coordination episode has
  already read what is on disk, and nothing else qualifies.
- **Both coordination calls must be idempotent.** Ora retries them. The held
  frame queue is the marker: a repeat `reactivate` finds nothing held — the
  state a finished reactivation leaves behind — and must not restart a CLI that
  already rescanned, which would tear down the sessions that came back from the
  first restart.

`SKILLS_RESOURCE.workspaceRelativePath` is `.opencode/skills`, OpenCode's own
directory. OpenCode also reads `.claude/skills` and `.agents/skills`, and
declaring either of those would be a mistake: Ora fully owns what it
materializes into a declared Resource, so it would reconcile away Skills another
tool put there.

This repository is itself such a Workspace — `.opencode/skills/` here is
materialized by Ora, not committed source. Do not hand-edit it.

## Resolving the CLI on Windows — always include `.bat`

**Every list of PATH spellings for a CLI must name `.exe`, `.cmd`, `.bat`, and
the bare name.** This has broken real installs more than once, always the same
way, and it is the single most important rule in this file after the one above.

```ts
return Deno.build.os === "windows"
  ? [
    `${BINARY_NAME}.exe`,
    `${BINARY_NAME}.cmd`,
    `${BINARY_NAME}.bat`,
    BINARY_NAME,
  ]
  : [BINARY_NAME];
```

Why each part matters:

- **The host's PATH lookup only appends `.exe` to a bare name.** It does not try
  `.cmd` or `.bat`. So naming just `opencode` finds nothing on a machine where
  the CLI is installed as a shim — which is what npm, bun, and many installers
  actually write.
- **Omitting a spelling is indistinguishable from "not installed".** The ladder
  in `spawnAgentProcess` only advances on `program_not_found`, so a missing
  spelling exhausts the list and raises `AGENT_NOT_INSTALLED` (`-32001`).
- **That failure surfaces as something unrelated.** Ora deliberately suppresses
  the log for `AgentNotInstalled` (`connection.rs`, "would flood the runtime
  log"), then tears the plugin process down — so the only thing the user sees is
  `plugin stdout closed` from the plugin runtime's stdout reader. Nothing in
  that message mentions PATH, the CLI, or the spelling that was missed. **Do not
  spend time debugging the plugin when you see `plugin stdout closed`; check the
  candidate list first.**
- **The order here is Windows' own `PATHEXT` precedence.** `.exe` first means
  the process the host holds is the CLI itself rather than a `cmd.exe` wrapper
  around it, which matters when the host kills it.

Adding a spelling is free: only "this one is not on PATH" advances to the next
candidate, and a candidate that resolved and then failed is raised as-is rather
than being buried under the next attempt. There is no downside to listing one
that no installer produces, and a real cost to omitting one that does.

**Order is a performance choice; coverage is a correctness one.** The sibling
`codeagent-agent` deliberately leads with `.bat` because that is how its CLI is
distributed, so the two lists differ on purpose — do not "resynchronize" them.
The coverage requirement is what is shared.

Note the list is deliberately _not_ derived from `bundledBinaryPath()`. The name
upstream publishes the binary under and the names a user's own install answers
to are independent facts that only happen to overlap today.

## Reaching the CLI: bundled, PATH, or override

`spawnOpenCode` asks the host for the package's own binary first and falls
through to the PATH ladder on exactly one condition — the host reporting
`package_command_missing`, which is how a package built without a bundled CLI
announces itself. Every other failure of a package-supplied executable is a
property of the package, identical on every retry, so it is raised as
`AGENT_UNUSABLE` (`-32002`) and Ora reports it once instead of retrying forever
as a missing CLI.

That fall-through is what lets one source publish as both release shapes without
a build-time flag; `bundle.config.ts` picks which one a release is. See
`README.md` for the release mechanics.

`ORA_OPENCODE_BIN` outranks both and is used alone, never with a fallback:
silently running a different CLI than the one a developer named is worse than
failing.

`assets/bin/` is git-ignored. It is staged only so `deno task simulate` can run
against a real binary; released packages have `scripts/package.ts` download the
CLI per target at package time. With nothing staged there the simulator answers
exactly as Ora would for a package that bundles no CLI, which exercises the PATH
fallback instead — a useful run, but a different one, so know which you are
doing.

## Provider environment

`services/provider-env.ts` merges extra environment into every spawn so the CLI
can start with a provider already configured and no login step. Two things about
it:

- The token is packed, not encrypted. `unpack` is right there in the file. The
  packing only keeps the raw value from sitting in the bundle as a plain string
  — treat anything put there as published.
- `PACKED = ""` means the function returns `{}` and the environment is left
  untouched, which is the state to leave the repository in. Set it through the
  file's own run mode (`deno run src/services/provider-env.ts "<value>"`) rather
  than pasting a raw value.

Invocation env wins over provider env
(`{ ...providerEnv(), ...invocation.env }`), so a caller can always override.

## Process ownership

Every subprocess goes through the host: `createHostProcesses(plugin)` →
`ora/childprocess/spawn`. Never `Deno.Command`. The host owns the OS handle,
terminates process trees, and reclaims whatever a plugin generation left behind
— none of which a sandboxed plugin can promise, least of all through a Windows
shim whose real child outlives a kill of the wrapper.

`OpenCodeClient` tracks generations: a process that is no longer `#running` was
superseded by a later `start()` — an Effect restart, typically — so its exit
must never clear the new process's tracking or fire `onExited`. The shared
`#expectedExit` flag reflects the newer generation's intent by then, which is
why the identity check comes first.

## Model discovery

`agent/list_models` receives the workspace `cwd` and answers it by running a
**separate, one-shot** `opencode acp`, not by borrowing the connection Ora
holds:

- A request injected into Ora's connection returns its answer down Ora's pipe.
- Ora's own `initialize` declares the client capability that decides whether the
  agent reports a model selector at all, and discovery runs before that.

The probe declares `clientCapabilities: { session: { configOptions: {} } }` —
without it the agent reports no model selector. Answers are cached per workspace
for five minutes; a failure is never cached.

Discovery is answered for the Workspace the host named, not for the plugin's
`#cwd`: `agent/start` gets a neutral directory, and a user can open pickers for
a project this connection never ran in.

`session/delete` is sent only when `initialize` advertised the capability.
OpenCode does not, so every probe leaves an empty session behind; the call stays
in place because the capability is the agent's to add, and sending it
unconditionally would earn a `method_not_found` on every discovery and clean up
nothing.

## Protocol hygiene

- **stdout is the binary protocol channel.** `protectProtocolStdout()` redirects
  every `console` method to stderr before any plugin code runs. A single
  `console.log` reaching stdout is read by the host as a corrupt frame and takes
  the plugin down.
- **ACP payloads are never parsed** on the bridge. Frames are re-framed between
  Ora's binary envelope and the CLI's NDJSON and otherwise passed through
  verbatim. `handlers/effects.ts` is the one exception, and a deliberately
  narrow one: it reads `method` and `id` off the envelope to track turns, and
  never looks at `params`.
- **Throw the right error code.** `AGENT_NOT_INSTALLED` (`-32001`) is retried
  quietly by Ora as expected local configuration; `AGENT_UNUSABLE` (`-32002`) is
  reported once and not retried; `-32000` is how an Effect Consumer says "not
  ready right now".

## Manifest

`orax.toml` is the manifest Ora reads. There is no `package.json` — it was a
legacy Ora manifest that no release has ever read, and its `engines.ora` field
held a plugin **SDK** version in a **host** version field. If a host requirement
ever needs declaring, it goes in `orax.toml`:

```toml
[dependencies]
ora = ">= x.y.z"
```

Ora parses and validates that table today but does not yet enforce it, and the
host version is not the SDK version — do not fill it with an SDK number.

## Working on this repository

- `deno task check` / `lint` / `format` / `simulate` / `build` / `package`.
- There is no unit test suite here; `tests/host-simulator.ts` drives the plugin
  the way Ora's host does and needs a real CLI, staged or on PATH. CI runs only
  `check` and `lint`, deliberately: type checking resolves the whole module
  graph, so it is also what catches an SDK version that is not published yet,
  and lint stays meaningful even while that fails.
- The SDK is imported from its published JSR package and pinned in `deno.json`;
  keep `deno.lock` synchronized when changing the SDK version.
- `.github/workflows/*.yml` and `scripts/package.ts` know nothing about OpenCode
  and are meant to be copied to another agent plugin unchanged, with only
  `bundle.config.ts` rewritten. Keep them generic.
- Bump `orax.toml` `version` before handing someone a `.orax` to import.
  `install_local` refuses a version that is already installed and never retires
  older ones, so reusing a number silently leaves the old code running.
