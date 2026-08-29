import type { BundleConfig } from "./scripts/package.ts";

/**
 * Declares the upstream CLI this plugin bundles, and which release asset serves each target.
 *
 * This is the only plugin-specific half of the release pipeline: `scripts/package.ts` and
 * `.github/workflows/release.yml` know nothing about OpenCode and are meant to be copied to
 * another agent plugin unchanged, with only this file rewritten.
 *
 * Every entry produces one `.orax`. A target absent here is simply not published: Ora refuses to
 * install a package built for another triple, so an unlisted host gets no package rather than a
 * binary it cannot run.
 */
export default {
  upstream: "anomalyco/opencode",
  assets: {
    "aarch64-apple-darwin": "opencode-darwin-arm64.zip",
    "x86_64-unknown-linux-gnu": "opencode-linux-x64.tar.gz",
    "x86_64-pc-windows-msvc": "opencode-windows-x64.zip",
  },
} satisfies BundleConfig;
