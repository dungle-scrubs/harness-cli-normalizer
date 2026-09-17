/**
 * Passthrough placement (ADR 0003 root-cause fix, probed 2026-09-17):
 * tokens after hcn's bare `--` reach the harness as native flags, so the
 * separator itself is never rendered into the harness argv. Each
 * descriptor declares where its tail goes (`launch.passthrough`):
 * `after-argv` appends past hcn's own argv, and `prompt-joins` refuses
 * before spawn on harnesses where no placement parses. The `before-prompt`
 * splice was removed (L5): no harness needed it, and a variadic tail ahead
 * of the prompt is a hazard (claude would take the prompt as a directory).
 * Absent means `after-argv`: trailing flags parsed on all five harnesses,
 * so an unverified descriptor gets the working default, never the
 * separator that broke every harness.
 *
 * Probe evidence (prompt "Reply with exactly OK", scrubbed env):
 * - claude 2.1.274: appended `--session-id <uuid>` honored as the session
 *   id; appended `--hcn-bogus-flag` rejected natively (unknown option).
 * - codex 0.154.0: appended `-c model_reasoning_effort="medium"` accepted
 *   (exit 0); appended bogus rejected (unexpected argument). A repeated
 *   `--sandbox` errors "cannot be used multiple times" - parsed as a flag,
 *   not a positional.
 * - pi 0.85.1: appended `--session-id <uuid>` honored; bogus rejected.
 * - muse 1.3.0: appended `--session-id <uuid>` honored; bogus rejected.
 * - cursor 2026.09.15: appended `--model gpt-5-mini` switched the run's
 *   model; bogus rejected. The RFC-05 prompt-joins verdict was the same
 *   `--` artifact, not the harness.
 * Resume checked on all five with the same placement.
 */
import { describe, expect, test } from "vitest";
import { ArgvRefusalError, buildSpawnArgv } from "../../src/interpretation/argv.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";

const SESSION_ID = "0199a4c5-1111-2222-3333-444455556666";
const TAIL = ["--native-flag", "value"];

const refusalOf = (work: () => unknown): ArgvRefusalError => {
  try {
    work();
  } catch (err) {
    if (err instanceof ArgvRefusalError) return err;
    throw err;
  }
  throw new Error("expected an ArgvRefusalError");
};

const AFTER: readonly HarnessDescriptor[] = [claudeCode, codexCli, piCli, museCode, cursorCli];

describe("after-argv placement", () => {
  for (const h of AFTER) {
    test(`${h.name} launch appends the tail with no separator`, () => {
      const argv = buildSpawnArgv(h, { prompt: "hi", passthrough: TAIL });
      expect(argv).not.toContain("--");
      expect(argv.slice(-TAIL.length)).toEqual(TAIL);
    });

    test(`${h.name} resume appends the tail with no separator`, () => {
      const argv = buildSpawnArgv(h, {
        prompt: "hi",
        resume: SESSION_ID,
        passthrough: TAIL,
      });
      expect(argv).not.toContain("--");
      expect(argv.slice(-TAIL.length)).toEqual(TAIL);
    });

    test(`${h.name} empty tail builds argv without a separator`, () => {
      const argv = buildSpawnArgv(h, { prompt: "hi", passthrough: [] });
      expect(argv).not.toContain("--");
    });
  }
});

describe("prompt-joins placement", () => {
  const joins: HarnessDescriptor = {
    ...claudeCode,
    launch: { ...claudeCode.launch, passthrough: "prompt-joins" },
  };

  test("launch tail refuses unsupported-passthrough naming the tokens", () => {
    const err = refusalOf(() => buildSpawnArgv(joins, { prompt: "hi", passthrough: TAIL }));
    expect(err.issue).toBe("unsupported-passthrough");
    expect(err.message).toContain("--native-flag");
  });

  test("resume tail refuses the same way", () => {
    const err = refusalOf(() =>
      buildSpawnArgv(joins, { prompt: "hi", resume: SESSION_ID, passthrough: TAIL }),
    );
    expect(err.issue).toBe("unsupported-passthrough");
  });

  test("the refusal names the descriptor in use's bin, not the default", () => {
    // N3: an override file can change bin (overrides.ts forbids only name),
    // so the refusal must carry the descriptor that raised it.
    const renamed: HarnessDescriptor = { ...joins, bin: "renamed-bin" };
    const err = refusalOf(() => buildSpawnArgv(renamed, { prompt: "hi", passthrough: TAIL }));
    expect(err).toBeInstanceOf(ArgvRefusalError);
    expect(err.message).toContain("renamed-bin");
    expect(err.hint).toContain(renamed.name);
  });
});

describe("absent placement", () => {
  test("a descriptor without passthrough appends like after-argv", () => {
    const { passthrough: _dropped, ...launch } = claudeCode.launch;
    const h: HarnessDescriptor = { ...claudeCode, launch };
    const argv = buildSpawnArgv(h, { prompt: "hi", passthrough: TAIL });
    expect(argv).not.toContain("--");
    expect(argv.slice(-TAIL.length)).toEqual(TAIL);
  });
});
