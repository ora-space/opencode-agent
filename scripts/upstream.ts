/**
 * Resolves and verifies the upstream OpenCode CLI release this plugin bundles.
 *
 * OpenCode publishes prebuilt archives as GitHub release assets rather than through npm, so what
 * this plugin pins is a release tag plus, per target, the SHA-256 GitHub itself computed for that
 * asset — the `digest` field the Releases API attaches to every asset, the same role npm's
 * `dist.integrity` plays for the sibling `claude-code-agent` and `codex-agent`. The resolved tag
 * and digests are committed to `upstream.lock.json`; `scripts/package.ts` reads only that lock and
 * never asks GitHub what "latest" means.
 */

export const LOCK_PATH = "upstream.lock.json";

export interface PinnedAsset {
  /** The release asset's file name, matching `bundle.config.ts`'s `assets` entry for this target. */
  name: string;
  size: number;
  sha256: string;
}

export interface UpstreamLock {
  /** GitHub `owner/name` the CLI is released from. */
  repo: string;
  tag: string;
  publishedAt: string;
  /** Keyed by target triple, matching `bundle.config.ts`'s `assets`. */
  assets: Record<string, PinnedAsset>;
}

interface GitHubAsset {
  name: string;
  size: number;
  /** `"sha256:<64 lowercase hex chars>"`, or absent for an asset GitHub has not digested. */
  digest: string | null;
}

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  assets: GitHubAsset[];
}

export async function readLock(path = LOCK_PATH): Promise<UpstreamLock> {
  return JSON.parse(await Deno.readTextFile(path)) as UpstreamLock;
}

export async function writeLock(
  lock: UpstreamLock,
  path = LOCK_PATH,
): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(lock, null, 2)}\n`);
}

/**
 * Calls the GitHub REST API, authenticating with `GITHUB_TOKEN`/`GH_TOKEN` when set.
 *
 * Unauthenticated requests are capped at 60/hour, which the once-nightly `upstream.yml` check
 * would not hit on its own, but a maintainer re-running `deno task sync` locally alongside other
 * GitHub API traffic easily can.
 */
async function githubApi<T>(path: string): Promise<T> {
  const headers: HeadersInit = { Accept: "application/vnd.github+json" };
  const token = Deno.env.get("GITHUB_TOKEN") ?? Deno.env.get("GH_TOKEN");
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const url = `https://api.github.com${path}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `${url} answered ${response.status}: ${await response.text()}`,
    );
  }
  return await response.json() as T;
}

export async function resolveUpstream(
  repo: string,
  assetsByTriple: Record<string, string>,
): Promise<UpstreamLock> {
  const release = await githubApi<GitHubRelease>(
    `/repos/${repo}/releases/latest`,
  );
  const byName = new Map(release.assets.map((asset) => [asset.name, asset]));

  const assets: Record<string, PinnedAsset> = {};
  for (const [triple, name] of Object.entries(assetsByTriple)) {
    const asset = byName.get(name);
    if (asset === undefined) {
      throw new Error(
        `${repo} ${release.tag_name} ships no asset named ${name} (target ${triple})`,
      );
    }
    const sha256 = asset.digest?.match(/^sha256:([0-9a-f]{64})$/)?.[1];
    if (sha256 === undefined) {
      throw new Error(
        `${repo} ${release.tag_name} asset ${name} carries no sha256 digest`,
      );
    }
    assets[triple] = { name, size: asset.size, sha256 };
  }

  return {
    repo,
    tag: release.tag_name,
    publishedAt: release.published_at,
    assets,
  };
}
