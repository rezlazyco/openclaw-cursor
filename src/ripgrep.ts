/**
 * Resolve and expose the Cursor SDK bundled ripgrep binary for local runs.
 */
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

function normalizeArch(arch: string): string {
  if (arch === "x64" || arch === "amd64") {
    return "x64";
  }
  if (arch === "arm64" || arch === "aarch64") {
    return "arm64";
  }
  return arch;
}

function vendorArch(arch: string): string {
  return arch === "arm64" ? "aarch64" : arch;
}

function isExecutable(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromRequireRoots(
  resolve: (require: NodeRequire) => string | undefined,
): string | undefined {
  const entryCandidates = [
    "/app/dist/index.js",
    path.join(process.cwd(), "dist/index.js"),
    import.meta.url,
  ];

  for (const entry of entryCandidates) {
    try {
      const require = createRequire(entry);
      const resolved = resolve(require);
      if (resolved && isExecutable(resolved)) {
        return resolved;
      }
    } catch {
      // Try the next OpenClaw entrypoint candidate.
    }
  }

  return undefined;
}

function resolveCursorSdkRipgrep(): string | undefined {
  return resolveFromRequireRoots((require) => {
    const platformPkg = `@cursor/sdk-${process.platform}-${normalizeArch(process.arch)}`;
    const binaryName = process.platform === "win32" ? "rg.exe" : "rg";
    return require.resolve(`${platformPkg}/bin/${binaryName}`);
  });
}

function resolveOpenClawBundledRipgrep(): string | undefined {
  return resolveFromRequireRoots((require) => {
    const arch = normalizeArch(process.arch);
    const pkg = `@openai/codex-linux-${arch}`;
    const pkgRoot = path.dirname(require.resolve(`${pkg}/package.json`));
    return path.join(
      pkgRoot,
      "vendor",
      `${vendorArch(arch)}-unknown-linux-musl`,
      "codex-path",
      "rg",
    );
  });
}

/**
 * Returns the absolute path to a usable `rg` binary for Cursor local runs.
 */
export function resolveCursorRipgrepPath(): string | undefined {
  const explicit = process.env.CURSOR_RIPGREP_PATH?.trim();
  if (explicit && path.isAbsolute(explicit) && isExecutable(explicit)) {
    return explicit;
  }

  return (
    resolveCursorSdkRipgrep() ??
    resolveOpenClawBundledRipgrep() ??
    (isExecutable("/usr/bin/rg") ? "/usr/bin/rg" : undefined)
  );
}

/**
 * Points the Cursor SDK local runtime at a usable ripgrep binary.
 * The SDK reads `CURSOR_RIPGREP_PATH` during `Agent.create({ local })`.
 */
export function ensureCursorRipgrepConfigured(logger?: {
  warn?: (message: string) => void;
}): void {
  const resolved = resolveCursorRipgrepPath();
  if (!resolved) {
    logger?.warn?.(
      `cursor: ripgrep not found for ${process.platform}-${process.arch}`,
    );
    return;
  }

  process.env.CURSOR_RIPGREP_PATH = resolved;
}
