import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip-js/zip-js";
import {
  AGENT_DECLARATION_ENTRY,
  agentDeclarationManifest,
  readAgentDeclaration,
  verifyPackagedAgentDeclaration,
} from "../scripts/agent-configuration.ts";

Deno.test("declaration publication is explicit and binds the exact bytes of every packaged copy", async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = join(root, "declaration.json");
    const bytes = new TextEncoder().encode(
      '{"schemaVersion":2,"agent":{"modelAccess":{"contractVersion":1,"protocols":["openai-completions","anthropic-messages"],"modelCardinality":"single"}}}\n',
    );
    await Deno.writeFile(path, bytes);
    const publication = await readAgentDeclaration(path);
    assertEquals(publication.bytes, bytes);
    assertEquals(agentDeclarationManifest(undefined), "");
    assertEquals(
      agentDeclarationManifest(publication).includes(publication.sha256),
      true,
    );
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(AGENT_DECLARATION_ENTRY, new Uint8ArrayReader(bytes));
    const artifact = join(root, "package.orax");
    await Deno.writeFile(artifact, await writer.close());
    await verifyPackagedAgentDeclaration(artifact, publication);
    const altered = { ...publication, sha256: "a".repeat(64) };
    await assertRejects(() =>
      verifyPackagedAgentDeclaration(artifact, altered)
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
