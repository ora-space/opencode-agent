/** Records the exact OpenCode CLI release and per-target asset digests used by a release. */
import { parseArgs } from "@std/cli/parse-args";
import bundle from "../bundle.config.ts";
import {
  LOCK_PATH,
  readLock,
  resolveUpstream,
  type UpstreamLock,
  writeLock,
} from "./upstream.ts";

const BEHIND = 20;

async function currentLock(): Promise<UpstreamLock | undefined> {
  try {
    return await readLock();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, { boolean: ["check"] });
  if (bundle.cli !== "bundled") {
    throw new Error("sync-upstream only applies to a bundled CLI");
  }

  const before = await currentLock();
  const resolved = await resolveUpstream(bundle.upstream, bundle.assets);
  const unchanged = before !== undefined &&
    JSON.stringify(before) === JSON.stringify(resolved);
  const summary = `${resolved.repo}@${resolved.tag}`;

  if (unchanged) {
    console.log(`${LOCK_PATH} is current: ${summary}`);
    return;
  }
  if (flags.check) {
    console.log(`${LOCK_PATH} is behind: ${summary}`);
    if (before !== undefined) {
      console.log(`  currently pinned: ${before.tag}`);
    }
    Deno.exit(BEHIND);
  }
  await writeLock(resolved);
  console.log(`${LOCK_PATH} now pins ${summary}`);
  for (const [triple, asset] of Object.entries(resolved.assets)) {
    console.log(`  ${triple}: ${asset.name} sha256:${asset.sha256}`);
  }
}

if (import.meta.main) await main();
