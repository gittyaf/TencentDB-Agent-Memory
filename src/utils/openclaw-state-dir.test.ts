import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { resolveOpenClawStateDir } from "./openclaw-state-dir.js";

describe("resolveOpenClawStateDir", () => {
  it("uses the runtime state resolver when available", () => {
    const stateDir = resolveOpenClawStateDir({
      resolveStateDir: () => "/tmp/openclaw-state",
    });

    expect(stateDir).toBe("/tmp/openclaw-state");
  });

  it("falls back to ~/.openclaw when runtime.state is not available", () => {
    const stateDir = resolveOpenClawStateDir(undefined);

    expect(stateDir).toBe(path.join(homedir(), ".openclaw"));
  });
});
