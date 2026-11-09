import {
  applyWindowsEnvironmentPatch,
  resolveWindowsEnvironment,
  type WindowsEnvironmentResolverOptions,
} from "@piedpiper/shared/shell";

export interface RepairWindowsPathOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly resolveEnvironment?: typeof resolveWindowsEnvironment;
  readonly resolverOptions?: WindowsEnvironmentResolverOptions;
  readonly logWarning?: (message: string, error?: unknown) => void;
}

function logRepairWarning(message: string, error?: unknown): void {
  console.warn(`[server] ${message}`, error instanceof Error ? error.message : (error ?? ""));
}

/**
 * Repairs a stale inherited Windows PATH (persisted User/Machine PATH, known CLI dirs, and the
 * PowerShell profile PATH when `node` is still missing). No-op on other platforms; never throws.
 */
export async function repairWindowsPath(options: RepairWindowsPathOptions = {}): Promise<boolean> {
  if ((options.platform ?? process.platform) !== "win32") return false;
  const env = options.env ?? process.env;
  const logWarning = options.logWarning ?? logRepairWarning;
  const resolveEnvironment = options.resolveEnvironment ?? resolveWindowsEnvironment;
  try {
    const patch = await resolveEnvironment(env, {
      onProbeError: (shell, error) =>
        logWarning(`Failed to read PATH from PowerShell ${shell}.`, error),
      ...options.resolverOptions,
    });
    return applyWindowsEnvironmentPatch(env, patch);
  } catch (error) {
    logWarning("Failed to repair the Windows PATH; keeping the inherited PATH.", error);
    return false;
  }
}
