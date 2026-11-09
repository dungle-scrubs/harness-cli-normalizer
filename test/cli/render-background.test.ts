import { expect, test } from "vitest";
import { createRenderState, renderEvent } from "../../src/cli/render.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

/** Capture renderEvent's stdout the way render-warning.test.ts does. */
const rendered = (event: Parameters<typeof renderEvent>[0], h = claudeCode): string => {
  const write = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    renderEvent(event, createRenderState(), h);
  } finally {
    process.stdout.write = write;
  }
  return output;
};

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

test("a backgrounded agent renders as a background agent", () => {
  expect(
    rendered({
      kind: "background",
      id: "a1",
      job: "agent",
      state: "running",
      backgrounded: true,
      description: "Count files",
    }),
  ).toBe(dim("\n  ◍ background agent running Count files"));
});

test("an inline agent renders as an inline agent", () => {
  expect(
    rendered({
      kind: "background",
      id: "a2",
      job: "agent",
      state: "completed",
      backgrounded: false,
      summary: "17 entries",
    }),
  ).toBe(dim("\n  ◍ inline agent completed 17 entries"));
});

test("an agent whose flag never arrived renders without a guess", () => {
  expect(rendered({ kind: "background", id: "a3", job: "agent", state: "running" })).toBe(
    dim("\n  ◍ agent running"),
  );
});

test("a shell renders unchanged: shells have no inline form", () => {
  expect(
    rendered({
      kind: "background",
      id: "s1",
      job: "shell",
      state: "completed",
      backgrounded: true,
      summary: "loop done",
    }),
  ).toBe(dim("\n  ◍ background shell completed loop done"));
});
