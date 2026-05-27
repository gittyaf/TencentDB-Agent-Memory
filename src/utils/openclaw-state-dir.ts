import { homedir } from "node:os";
import path from "node:path";

export interface OpenClawRuntimeStateLike {
  resolveStateDir?: () => string;
}

export function resolveOpenClawStateDir(
  runtimeState: OpenClawRuntimeStateLike | undefined,
): string {
  return runtimeState?.resolveStateDir?.() ?? path.join(homedir(), ".openclaw");
}
