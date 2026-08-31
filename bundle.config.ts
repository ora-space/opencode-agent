import type { BundleConfig } from "./scripts/package.ts";
import { bundledBinaryPath } from "./src/services/bundled-binary.ts";

/**
 * Declares how this plugin reaches the OpenCode CLI, and therefore what its release looks like.
 *
 * This is the only plugin-specific half of the release pipeline: `scripts/package.ts` and
 * `.github/workflows/release.yml` know nothing about OpenCode and are meant to be copied to
 * another agent plugin unchanged, with only this file rewritten.
 *
 * `cli: "bundled"` ships the CLI inside the package: every entry below produces one `.orax`, and
 * a target absent here is simply not published, because Ora refuses to install a package built
 * for another triple. `cli: "user_installed"` instead produces a single package every host can
 * install, which runs whatever OpenCode the user has on their PATH. The plugin source is the same
 * either way — it finds out which package it is running from when it spawns — so switching is a
 * one-line change here.
 */
export default {
  cli: "bundled",
  upstream: "anomalyco/opencode",
  assets: {
    "aarch64-apple-darwin": "opencode-darwin-arm64.zip",
    "x86_64-unknown-linux-gnu": "opencode-linux-x64.tar.gz",
    "x86_64-pc-windows-msvc": "opencode-windows-x64.zip",
  },
  binaryPath: bundledBinaryPath,
} satisfies BundleConfig;
