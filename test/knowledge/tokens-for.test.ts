/**
 * RFC-02 change 1: one owner for the render-to-tokens rule. Every arm of
 * the turn-option renderer calls tokensFor; nothing else maps a render
 * kind to argv tokens.
 */
import { describe, expect, test } from "vitest";
import { tokensFor } from "../../src/knowledge/descriptor.js";

describe("tokensFor", () => {
  test("flag-value renders companion flags, the flag, then the value", () => {
    expect(
      tokensFor(
        { kind: "flag-value", flag: "--system-prompt", extraFlags: ["--exclude-dynamic"] },
        "be terse",
      ),
    ).toEqual(["--exclude-dynamic", "--system-prompt", "be terse"]);
    expect(tokensFor({ kind: "flag-value", flag: "--effort" }, "high")).toEqual([
      "--effort",
      "high",
    ]);
  });

  test("flag-value with no value is a descriptor error, not an empty token", () => {
    expect(() => tokensFor({ kind: "flag-value", flag: "--effort" })).toThrow(/value/);
  });

  test("config-kv quotes for TOML by default and passes prose verbatim on request", () => {
    expect(
      tokensFor({ kind: "config-kv", flag: "-c", key: "model_reasoning_effort" }, "high"),
    ).toEqual(["-c", 'model_reasoning_effort="high"']);
    expect(
      tokensFor(
        { kind: "config-kv", flag: "-c", key: "instructions" },
        "/path/or literal",
        "verbatim",
      ),
    ).toEqual(["-c", "instructions=/path/or literal"]);
  });

  test("flag-list renders its fixed flags and ignores any value", () => {
    expect(tokensFor({ kind: "flag-list", flags: ["--disable-write", "--disable-shell"] })).toEqual(
      ["--disable-write", "--disable-shell"],
    );
    expect(tokensFor({ kind: "flag-list", flags: ["-ns"] }, "ignored")).toEqual(["-ns"]);
  });
});
