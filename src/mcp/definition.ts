import type { AgentMcpConfigurationDefinition } from "@ora-space/plugin-sdk";
import { McpMaterializationError } from "./errors.ts";
import type { OpenCodeMcpMaterializer } from "./materializer.ts";

/** Builds the one high-level SDK definition that pairs OpenCode's HTTP capability and handler. */
export function defineOpenCodeMcpConfiguration(
  materializer: () => OpenCodeMcpMaterializer | undefined,
): AgentMcpConfigurationDefinition {
  return {
    protocolVersion: 1,
    transports: ["http"],
    coordination: "wait_for_idle_and_restart",
    configureWorkspace: (request) => {
      const active = materializer();
      if (active === undefined) {
        throw new McpMaterializationError("mcp_materialization_conflict");
      }
      return active.configureWorkspace(request);
    },
  };
}
