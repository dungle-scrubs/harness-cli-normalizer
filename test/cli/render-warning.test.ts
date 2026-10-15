import { expect, test } from "vitest";
import { createRenderState, renderEvent } from "../../src/cli/render.js";

test("an advisory warning is visible without the error marker or red styling", () => {
  const write = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    renderEvent({ kind: "warning", message: "verify the session id" }, createRenderState());
  } finally {
    process.stdout.write = write;
  }
  expect(output).toBe("\x1b[33m\n  ! verify the session id\x1b[0m");
});
