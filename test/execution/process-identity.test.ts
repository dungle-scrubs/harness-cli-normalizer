import { describe, expect, test } from "vitest";
import { waitForChildExec } from "../../src/execution/process-identity.js";

const PARENT = "hcn\0run\0";

describe("waitForChildExec", () => {
  test("pre-exec cmdline, then empty, then child argv resolves exec'd and stops reading", async () => {
    const samples = [PARENT, PARENT, PARENT, "", "codex\0exec\0"];
    let reads = 0;
    const readCmdline = (pid: number): string => {
      reads += 1;
      if (pid === process.pid) return PARENT;
      const next = samples.shift();
      if (next === undefined) throw new Error("read past exec");
      return next;
    };
    const result = await waitForChildExec(4242, {
      now: () => 1000,
      platform: "linux",
      readCmdline,
      sleep: () => Promise.resolve(),
    });
    expect(result).toBe("exec'd");
    expect(reads).toBe(6);
  });

  test("cmdline never changes resolves unknown at the 2000 ms budget", async () => {
    const start = 5000;
    let nowMs = start;
    const readCmdline = (pid: number): string => {
      if (pid === process.pid) return PARENT;
      return PARENT;
    };
    const result = await waitForChildExec(4242, {
      now: () => nowMs,
      platform: "linux",
      readCmdline,
      sleep: () => {
        nowMs += 2;
        return Promise.resolve();
      },
    });
    expect(result).toBe("unknown");
    expect(nowMs - start).toBeGreaterThanOrEqual(2000);
  });

  test("read error resolves unknown at once", async () => {
    let reads = 0;
    let sleeps = 0;
    const readCmdline = (pid: number): string => {
      reads += 1;
      if (pid === process.pid) return PARENT;
      throw new Error("ENOENT");
    };
    const result = await waitForChildExec(4242, {
      now: () => 1000,
      platform: "linux",
      readCmdline,
      sleep: () => {
        sleeps += 1;
        return Promise.resolve();
      },
    });
    expect(result).toBe("unknown");
    expect(reads).toBe(2);
    expect(sleeps).toBe(0);
  });

  test("non-Linux platform resolves exec'd with zero reads", async () => {
    let reads = 0;
    const result = await waitForChildExec(4242, {
      now: () => 1000,
      platform: "darwin",
      readCmdline: () => {
        reads += 1;
        return PARENT;
      },
      sleep: () => Promise.resolve(),
    });
    expect(result).toBe("exec'd");
    expect(reads).toBe(0);
  });
});
