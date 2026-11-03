/**
 * Worker runtime selection (issue #440 review): the spawn adapter picks
 * the worker's runtime from the host's identity (`process.versions.bun`),
 * never from the executable path's spelling. A Bun installed under a path
 * containing "node" would otherwise run the node-first SDK worker under
 * Bun; a renamed node binary must still run the worker under itself. The
 * seam is the process properties themselves, saved and faithfully
 * restored, so the same cases hold on the Node and Bun test lanes.
 */
import { describe, expect, test } from "vitest";
import { sdkWorkerArgvFor } from "../../src/execution/node-deps.js";

const withHostRuntime = (execPath: string, bun: string | undefined, run: () => void): void => {
  const execDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
  const bunDescriptor = Object.getOwnPropertyDescriptor(process.versions, "bun");
  Object.defineProperty(process, "execPath", {
    ...execDescriptor,
    value: execPath,
    writable: true,
    configurable: true,
  });
  if (bun === undefined) delete process.versions.bun;
  else
    Object.defineProperty(process.versions, "bun", {
      value: bun,
      writable: true,
      configurable: true,
    });
  try {
    run();
  } finally {
    if (execDescriptor !== undefined) Object.defineProperty(process, "execPath", execDescriptor);
    if (bunDescriptor !== undefined) Object.defineProperty(process.versions, "bun", bunDescriptor);
    else delete process.versions.bun;
  }
};

describe("sdk worker runtime selection", () => {
  test("a Bun host whose path contains 'node' still runs the worker under node", () => {
    withHostRuntime("/opt/node-runner/bin/bun", "1.3.14", () => {
      expect(sdkWorkerArgvFor("hcn-cursor-sdk-worker")?.[0]).toBe("node");
    });
  });

  test("a Bun host without 'node' in its path keeps the PATH fallback", () => {
    withHostRuntime("/usr/local/bin/bun", "1.3.14", () => {
      expect(sdkWorkerArgvFor("hcn-cursor-sdk-worker")?.[0]).toBe("node");
    });
  });

  test("a node host keeps process.execPath even when its filename was renamed", () => {
    withHostRuntime("/usr/local/bin/hcn-runner", undefined, () => {
      expect(sdkWorkerArgvFor("hcn-cursor-sdk-worker")?.[0]).toBe("/usr/local/bin/hcn-runner");
    });
  });

  test("a node host under the usual name runs the worker under itself", () => {
    withHostRuntime("/usr/local/bin/node", undefined, () => {
      expect(sdkWorkerArgvFor("hcn-cursor-sdk-worker")?.[0]).toBe("/usr/local/bin/node");
    });
  });
});
