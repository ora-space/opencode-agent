/** Stable public failure codes emitted by OpenCode MCP materialization. */
export type McpMaterializationErrorCode =
  | "mcp_materialization_conflict"
  | "mcp_native_key_collision"
  | "mcp_config_file_tracked"
  | "mcp_config_git_exclude_failed"
  | "mcp_config_permissions_failed";

/**
 * Carries only a stable code so a thrown error cannot accidentally echo snapshot secrets.
 *
 * The SDK converts the message to JSON-RPC; keeping it equal to the code makes both the wire
 * failure and plugin stderr safe even when an upstream error contains a URL or header value.
 */
export class McpMaterializationError extends Error {
  readonly code: McpMaterializationErrorCode;

  constructor(code: McpMaterializationErrorCode) {
    super(code);
    this.name = "McpMaterializationError";
    this.code = code;
  }
}
