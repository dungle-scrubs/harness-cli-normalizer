/**
 * Issue #325: a limit wall that states its reset time in prose must yield
 * that time, and nothing else may. Codex prints an absolute local
 * timestamp (format_retry_timestamp: process-local zone, minute precision,
 * no zone printed); pi's openai-codex 429 path prints relative minutes.
 * Every other phrasing stays null - a reset is never guessed.
 */
import { describe, expect, test } from "vitest";
import type { ResetHint } from "../../src/interpretation/limits.js";
import { resetHintInLine, resolveResetHint } from "../../src/interpretation/limits.js";

/** The live codex 0.158.0 wall (issue #325): +07:00 machine, true reset
 * 2026-10-03T16:58:16Z, printed local and truncated to the minute. */
const liveWall =
  "You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 3rd, 2026 11:58 PM.";

const plus420 = () => 420;

describe("resetHintInLine", () => {
  test("parses the live codex wall into local calendar fields", () => {
    expect(resetHintInLine(liveWall)).toEqual({
      kind: "local-datetime",
      year: 2026,
      month: 10,
      day: 3,
      hour: 23,
      minute: 58,
    });
  });

  test("resolves the live wall in a +07:00 zone to the end of the printed minute", () => {
    const hint = resetHintInLine(liveWall) as Extract<ResetHint, { kind: "local-datetime" }>;
    const resolved = resolveResetHint(hint, 0, plus420);
    expect(resolved).toBe(Date.parse("2026-10-03T16:59:00Z"));
    // Upper bound of the truncated minute: never early (>= the true reset
    // 2026-10-03T16:58:16Z), never more than 60 s past it.
    expect(resolved ?? 0).toBeGreaterThanOrEqual(Date.parse("2026-10-03T16:58:16Z"));
    expect((resolved ?? 0) - Date.parse("2026-10-03T16:58:16Z")).toBeLessThanOrEqual(60_000);
  });

  test("parses the capitalized Try again at form (codex Enterprise branch)", () => {
    const wall = "You’ve hit your usage limit. Try again at Oct 3rd, 2026 11:58 PM.";
    const hint = resetHintInLine(wall);
    expect(hint).toEqual({
      kind: "local-datetime",
      year: 2026,
      month: 10,
      day: 3,
      hour: 23,
      minute: 58,
    });
  });

  test("every chrono %b month name parses", () => {
    for (const [token, month] of [
      ["Jan", 1],
      ["Feb", 2],
      ["Mar", 3],
      ["Apr", 4],
      ["May", 5],
      ["Jun", 6],
      ["Jul", 7],
      ["Aug", 8],
      ["Sep", 9],
      ["Oct", 10],
      ["Nov", 11],
      ["Dec", 12],
    ] as const) {
      expect(resetHintInLine(`try again at ${token} 1st, 2026 1:02 AM.`)).toMatchObject({
        kind: "local-datetime",
        month,
      });
    }
  });

  test("parses the same-day time-only form", () => {
    expect(resetHintInLine("You’ve hit your usage limit. Try again at 9:05 AM.")).toEqual({
      kind: "local-time",
      hour: 9,
      minute: 5,
    });
  });

  test("12 AM is hour 0 and 12 PM is hour 12", () => {
    expect(resetHintInLine("or try again at 12:30 AM.")).toEqual({
      kind: "local-time",
      hour: 0,
      minute: 30,
    });
    expect(resetHintInLine("or try again at 12:30 PM.")).toEqual({
      kind: "local-time",
      hour: 12,
      minute: 30,
    });
  });

  test("resolves the same-day form against today's local date", () => {
    const hint = resetHintInLine("…or try again at 9:05 AM.") as Extract<
      ResetHint,
      { kind: "local-time" }
    >;
    // 2026-09-30T01:00:00Z is 08:00 local (+07:00), so the wall lands on
    // local 2026-09-30 09:05 -> 02:05Z, plus the truncated-minute bound.
    const resolved = resolveResetHint(hint, Date.parse("2026-09-30T01:00:00Z"), plus420);
    expect(resolved).toBe(Date.parse("2026-09-30T02:06:00Z"));
  });

  test("parses pi's relative form with and without the tilde", () => {
    const pi429 = "You have hit your ChatGPT usage limit (pro plan). Try again in ~42 min.";
    expect(resetHintInLine(pi429)).toEqual({ kind: "relative", minutes: 42 });
    expect(resetHintInLine("Try again in 42 mins.")).toEqual({ kind: "relative", minutes: 42 });
    expect(resetHintInLine("Try again in 42 minutes.")).toEqual({
      kind: "relative",
      minutes: 42,
    });
  });

  test("a relative hint resolves to the upper bound of pi's rounded minutes", () => {
    const hint = resetHintInLine("Try again in ~42 min.") as Extract<
      ResetHint,
      { kind: "relative" }
    >;
    const resolved = resolveResetHint(hint, Date.parse("2026-09-30T01:00:00Z"), undefined);
    expect(resolved).toBe(Date.parse("2026-09-30T01:00:00Z") + 42 * 60_000 + 30_000);
  });

  test("caps a relative hint at seven days; the boundary itself still resolves", () => {
    expect(resolveResetHint({ kind: "relative", minutes: 7 * 24 * 60 }, 1000, undefined)).toBe(
      1000 + 7 * 24 * 60 * 60_000 + 30_000,
    );
    expect(resetHintInLine("Try again in 10081 min.")).toBeNull();
  });

  test("no reset phrasing yields null - never a guess", () => {
    expect(resetHintInLine("You’ve hit your usage limit. …or try again later.")).toBeNull();
    expect(resetHintInLine("Codex error: The usage limit has been reached")).toBeNull();
    expect(resetHintInLine("try again at 13:00 PM.")).toBeNull();
    expect(resetHintInLine("try again at Map 3rd, 2026 1:00 PM.")).toBeNull();
  });
});

describe("resolveResetHint", () => {
  test("a day past its month's length never resolves (Feb 30)", () => {
    expect(
      resolveResetHint(
        { kind: "local-datetime", year: 2026, month: 2, day: 30, hour: 10, minute: 0 },
        0,
        plus420,
      ),
    ).toBeNull();
    // Feb 29 exists in 2028 and resolves.
    expect(
      resolveResetHint(
        { kind: "local-datetime", year: 2028, month: 2, day: 29, hour: 10, minute: 0 },
        0,
        plus420,
      ),
    ).toBe(Date.UTC(2028, 1, 29, 10, 0) - 420 * 60_000 + 60_000);
  });

  test("one DST correction pass handles a zone that shifts across the instant", () => {
    // US spring-forward 2026-03-08: EST (-300) becomes EDT (-240) at
    // 07:00Z. The wall 02:30 local reads -300 at the wall, so the first
    // guess lands past the transition and the second lookup corrects.
    const boundary = Date.parse("2026-03-08T07:00:00Z");
    const off = (ms: number): number => (ms < boundary ? -300 : -240);
    expect(
      resolveResetHint(
        { kind: "local-datetime", year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
        0,
        off,
      ),
    ).toBe(Date.parse("2026-03-08T06:31:00Z"));
  });

  test("without an offset function local forms stay unknown; relative still resolves", () => {
    expect(
      resolveResetHint(
        { kind: "local-datetime", year: 2026, month: 10, day: 3, hour: 23, minute: 58 },
        0,
        undefined,
      ),
    ).toBeNull();
    expect(resolveResetHint({ kind: "local-time", hour: 9, minute: 5 }, 0, undefined)).toBeNull();
    expect(resolveResetHint({ kind: "relative", minutes: 42 }, 1000, undefined)).toBe(
      1000 + 42 * 60_000 + 30_000,
    );
  });
});
