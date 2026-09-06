/**
 * RFC-02 change 6: one owner for the precedence of hcn-owned behaviour
 * (question mode, wall-clock timeout) - arg > project > user > default -
 * used by run, resume, and session alike, with the tier label the
 * provenance line prints.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveBehavior } from "../../src/interpretation/resolve-options.js";

describe("resolveBehavior", () => {
  test("the arg wins over both tiers, project over user, and default last", () => {
    expect(
      resolveBehavior(
        { questions: "none", timeoutSeconds: 5 },
        { user: { questions: "assume", timeout: 30 }, project: { questions: "ask", timeout: 60 } },
      ),
    ).toEqual({
      questions: { value: "none", tier: "arg" },
      timeoutSeconds: { value: 5, tier: "arg" },
    });
    expect(
      resolveBehavior(
        {},
        { user: { questions: "assume", timeout: 30 }, project: { questions: "ask", timeout: 60 } },
      ),
    ).toEqual({
      questions: { value: "ask", tier: "project-config" },
      timeoutSeconds: { value: 60, tier: "project-config" },
    });
    expect(resolveBehavior({}, { user: { questions: "assume", timeout: 30 } })).toEqual({
      questions: { value: "assume", tier: "user-config" },
      timeoutSeconds: { value: 30, tier: "user-config" },
    });
    expect(resolveBehavior({}, {})).toEqual({
      questions: { value: "ask", tier: "default" },
      timeoutSeconds: { value: undefined, tier: "default" },
    });
  });

  test("timeout 0 is an explicit disable, not an absence", () => {
    expect(
      resolveBehavior({ timeoutSeconds: 0 }, { user: { timeout: 30 } }).timeoutSeconds,
    ).toEqual({ value: 0, tier: "arg" });
  });

  test("the question-mode value list has one owner in source", () => {
    const src = join(import.meta.dirname, "../../src");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.endsWith(".ts")) continue;
        const text = readFileSync(full, "utf8");
        if (/"ask",\s*"assume",\s*"none"/.test(text)) hits.push(full.slice(src.length + 1));
      }
    };
    walk(src);
    expect(hits).toEqual(["interpretation/question.ts"]);
  });
});
