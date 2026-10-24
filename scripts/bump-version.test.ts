import { assertEquals, assertThrows } from "@std/assert";
import { bumpManifest, bumpVersion } from "./bump-version.ts";

Deno.test("bumps the patch of an unsuffixed version", () => {
  assertEquals(bumpVersion("0.6.11"), "0.6.12");
  assertEquals(bumpVersion("1.0.0"), "1.0.1");
});

Deno.test("bumps the trailing counter of a suffixed version", () => {
  assertEquals(bumpVersion("0.7.0-opencode2.1"), "0.7.0-opencode2.2");
  assertEquals(bumpVersion("1.2.3-rc.9"), "1.2.3-rc.10");
});

Deno.test("starts a counter when the suffix has none", () => {
  assertEquals(bumpVersion("0.7.0-opencode2"), "0.7.0-opencode2.1");
});

Deno.test("refuses a version it cannot bump predictably", () => {
  for (
    const version of [
      "0.7",
      "0.7.0.1",
      "v0.7.0",
      "0.7.0-",
      "0.7.0-a..b",
      "0.7.0+build",
    ]
  ) {
    assertThrows(() => bumpVersion(version), Error, version);
  }
});

Deno.test("rewrites the manifest's version line and nothing else", () => {
  const source = 'resolver = 1\ntitle = "OpenCode"\n' +
    'version = "0.7.0-opencode2.1"\nkind = "agent"\n';
  const bumped = bumpManifest(source);
  assertEquals(bumped.current, "0.7.0-opencode2.1");
  assertEquals(bumped.next, "0.7.0-opencode2.2");
  assertEquals(
    bumped.text,
    'resolver = 1\ntitle = "OpenCode"\n' +
      'version = "0.7.0-opencode2.2"\nkind = "agent"\n',
  );
});

Deno.test("refuses a manifest that declares no version", () => {
  assertThrows(() => bumpManifest('title = "OpenCode"\n'), Error);
});
