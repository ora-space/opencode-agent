import { dirname, isAbsolute, join, normalize, relative } from "@std/path";
import type {
  AtomicReplacer,
  MaterializationFileSystem,
} from "./filesystem.ts";
import { McpMaterializationError } from "./errors.ts";

const MANAGED_EXCLUDE = "/.opencode/opencode.json";

/** Verifies repository safety and prepares only the repository-local exclude. */
export interface GitWorkspaceGuard {
  prepare(workspaceRoot: string, managedPath: string): Promise<void>;
}

interface CommandResult {
  success: boolean;
  code: number;
  stdout: string;
}

export type GitCommand = (
  workspaceRoot: string,
  args: readonly string[],
) => Promise<CommandResult>;

/**
 * Performs Git inspection before plaintext staging and atomically updates the local exclude.
 *
 * Exit details are deliberately discarded from public failures because Git can include absolute
 * paths. Exit 128 from the initial probe is the only non-error outcome: it identifies a non-Git
 * Workspace, where the rest of the safety policy still runs.
 */
export class RepositoryLocalGitGuard implements GitWorkspaceGuard {
  readonly #run: GitCommand;
  readonly #fs: MaterializationFileSystem;
  readonly #replacer: AtomicReplacer;

  constructor(
    fs: MaterializationFileSystem,
    replacer: AtomicReplacer,
    run: GitCommand = runGit,
  ) {
    this.#fs = fs;
    this.#replacer = replacer;
    this.#run = run;
  }

  async prepare(workspaceRoot: string, managedPath: string): Promise<void> {
    const topLevel = await this.#run(workspaceRoot, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (!topLevel.success) {
      if (topLevel.code === 128) {
        return;
      }
      throw new McpMaterializationError("mcp_config_git_exclude_failed");
    }
    const repositoryRoot = normalize(topLevel.stdout.trim());
    let normalizedWorkspace: string;
    try {
      // Windows temporary/worktree paths may arrive in 8.3 form while Git returns the long form.
      normalizedWorkspace = normalize(await Deno.realPath(workspaceRoot));
    } catch {
      throw new McpMaterializationError("mcp_config_git_exclude_failed");
    }
    if (
      repositoryRoot.length === 0 ||
      repositoryRoot.toLowerCase() !== normalizedWorkspace.toLowerCase() ||
      relative(normalize(workspaceRoot), normalize(managedPath)).replaceAll(
          "\\",
          "/",
        ) !==
        ".opencode/opencode.json"
    ) {
      throw new McpMaterializationError("mcp_config_git_exclude_failed");
    }

    const tracked = await this.#run(workspaceRoot, [
      "ls-files",
      "--error-unmatch",
      "--",
      ".opencode/opencode.json",
    ]);
    if (tracked.success) {
      throw new McpMaterializationError("mcp_config_file_tracked");
    }
    if (tracked.code !== 1) {
      throw new McpMaterializationError("mcp_config_git_exclude_failed");
    }

    const excludeResult = await this.#run(workspaceRoot, [
      "rev-parse",
      "--git-path",
      "info/exclude",
    ]);
    if (!excludeResult.success || excludeResult.stdout.trim().length === 0) {
      throw new McpMaterializationError("mcp_config_git_exclude_failed");
    }
    const rawExclude = excludeResult.stdout.trim();
    const excludePath = normalize(
      isAbsolute(rawExclude) ? rawExclude : join(workspaceRoot, rawExclude),
    );
    await this.#ensureExactExclude(excludePath);
  }

  async #ensureExactExclude(excludePath: string): Promise<void> {
    try {
      const existing = await this.#fs.read(excludePath) ?? new Uint8Array();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(existing);
      if (text.split(/\r?\n/).includes(MANAGED_EXCLUDE)) {
        return;
      }
      const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
      const desired = new TextEncoder().encode(
        `${text}${separator}${MANAGED_EXCLUDE}\n`,
      );
      await this.#fs.ensureDirectory(dirname(excludePath));
      const staging = await this.#fs.createStagingFile(excludePath, desired);
      try {
        await this.#replacer.replace(staging, excludePath);
      } finally {
        await this.#fs.cleanup(staging);
      }
    } catch (error) {
      if (error instanceof McpMaterializationError) {
        throw error;
      }
      throw new McpMaterializationError("mcp_config_git_exclude_failed");
    }
  }
}

async function runGit(
  workspaceRoot: string,
  args: readonly string[],
): Promise<CommandResult> {
  try {
    const result = await new Deno.Command("git", {
      args: ["-C", workspaceRoot, ...args],
      stdout: "piped",
      stderr: "null",
    }).output();
    return {
      success: result.success,
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
    };
  } catch {
    throw new McpMaterializationError("mcp_config_git_exclude_failed");
  }
}
