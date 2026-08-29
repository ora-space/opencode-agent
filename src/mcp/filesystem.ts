import { dirname, join } from "@std/path";
import { McpMaterializationError } from "./errors.ts";

/** Filesystem operations kept separate from permission and replacement policy for fault tests. */
export interface MaterializationFileSystem {
  assertSafeManagedPaths(
    directoryPath: string,
    targetPath: string,
  ): Promise<void>;
  read(path: string): Promise<Uint8Array | undefined>;
  ensureDirectory(path: string): Promise<void>;
  createStagingFile(targetPath: string, bytes: Uint8Array): Promise<string>;
  removeFile(path: string): Promise<void>;
  cleanup(path: string): Promise<void>;
}

/** Applies the current-user-only policy before plaintext can reach the managed pathname. */
export interface PermissionRestrictor {
  restrict(path: string): Promise<void>;
}

/** Commits one already-restricted same-directory staging file as the managed document. */
export interface AtomicReplacer {
  replace(stagingPath: string, targetPath: string): Promise<void>;
}

/** Production Deno filesystem implementation with exclusive same-directory staging files. */
export class DenoMaterializationFileSystem
  implements MaterializationFileSystem {
  async assertSafeManagedPaths(
    directoryPath: string,
    targetPath: string,
  ): Promise<void> {
    // A linked `.opencode` directory would move plaintext outside the Workspace while every
    // lexical containment check still passed. Existing target links are rejected for the same
    // reason even when their bytes happen to match an applied fingerprint.
    for (const path of [directoryPath, targetPath]) {
      try {
        if ((await Deno.lstat(path)).isSymlink) {
          throw new McpMaterializationError("mcp_materialization_conflict");
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          continue;
        }
        throw error;
      }
    }
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    try {
      return await Deno.readFile(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return undefined;
      }
      throw error;
    }
  }

  async ensureDirectory(path: string): Promise<void> {
    await Deno.mkdir(path, { recursive: true, mode: 0o700 });
  }

  async createStagingFile(
    targetPath: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const stagingPath = join(
      dirname(targetPath),
      `.opencode.json.ora-${crypto.randomUUID()}.tmp`,
    );
    const file = await Deno.open(stagingPath, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    try {
      await file.write(bytes);
      await file.sync();
    } catch (error) {
      file.close();
      await this.cleanup(stagingPath);
      throw error;
    }
    file.close();
    return stagingPath;
  }

  async removeFile(path: string): Promise<void> {
    await Deno.remove(path);
  }

  async cleanup(path: string): Promise<void> {
    await Deno.remove(path).catch(() => undefined);
  }
}

/** Restricts staging bytes to the current account on Unix and Windows before publication. */
export class CurrentUserPermissionRestrictor implements PermissionRestrictor {
  async restrict(path: string): Promise<void> {
    try {
      if (Deno.build.os !== "windows") {
        await Deno.chmod(path, 0o600);
        return;
      }
      const user = new TextDecoder().decode(
        (await new Deno.Command("whoami", { stdout: "piped" }).output()).stdout,
      ).trim();
      if (user.length === 0) {
        throw new Error("current account is unavailable");
      }
      const result = await new Deno.Command("icacls", {
        args: [path, "/inheritance:r", "/grant:r", `${user}:(F)`],
        stdout: "null",
        stderr: "null",
      }).output();
      if (!result.success) {
        throw new Error("permission restriction failed");
      }
    } catch {
      throw new McpMaterializationError("mcp_config_permissions_failed");
    }
  }
}

/** Uses the platform rename primitive, which atomically replaces a file on the same volume. */
export class DenoAtomicReplacer implements AtomicReplacer {
  async replace(stagingPath: string, targetPath: string): Promise<void> {
    await Deno.rename(stagingPath, targetPath);
    // Syncing the committed file keeps the success boundary after the bytes are durable. Directory
    // sync is unavailable on Windows and the rename primitive already provides its only boundary.
    const committed = await Deno.open(targetPath, { read: true, write: true });
    try {
      await committed.sync();
    } finally {
      committed.close();
    }
  }
}
