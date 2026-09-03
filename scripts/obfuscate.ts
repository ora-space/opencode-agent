/**
 * Renames the key-packing identifiers in the bundled `dist/main.js` so the mechanism doesn't show
 * up under its own name to a casual grep of the shipped bundle.
 *
 * This is not encryption and doesn't need to be — see INTERNAL.md's "原理" section. Renaming here
 * rather than in `src/` keeps the source readable for whoever maintains `provider-env.ts`, while
 * the artifact that actually ships no longer spells out PACKED/MASK/unpack in plain text.
 *
 * Runs automatically as the second half of `deno task build`. If `src/services/provider-env.ts`
 * has since been removed (see INTERNAL.md's "移除特供版"), none of these names appear in the
 * bundle and this step is a silent no-op.
 */

const DIST_MAIN = "dist/main.js";

const RENAMES: Record<string, string> = {
  PACKED: "_0x4f2a",
  MASK: "_0x9c1e",
  unpack: "_0x77bd",
};

let source = await Deno.readTextFile(DIST_MAIN);
const renamed: string[] = [];
for (const [from, to] of Object.entries(RENAMES)) {
  const pattern = new RegExp(`\\b${from}\\b`, "g");
  if (!pattern.test(source)) continue;
  source = source.replace(pattern, to);
  renamed.push(from);
}

if (renamed.length === 0) {
  console.log(`obfuscate: nothing to rename in ${DIST_MAIN}`);
} else {
  await Deno.writeTextFile(DIST_MAIN, source);
  console.log(`obfuscate: renamed ${renamed.join(", ")} in ${DIST_MAIN}`);
}
