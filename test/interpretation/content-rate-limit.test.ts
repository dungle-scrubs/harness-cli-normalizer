/**
 * RFC-02 change 12 (rate-limit item): claude's rate_limit_event is read
 * by the claude content reader in interpretation, as a limit-class
 * content event carrying the reset time, and the execution-layer decoder
 * no longer branches on a harness name.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { decodeParsed, freshDecodeState } from "../../src/execution/decode.js";
import { contentEventsOf } from "../../src/interpretation/content.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const event = (status: string, resetsAt?: number) => ({
  type: "rate_limit_event",
  rate_limit_info: { status, ...(resetsAt !== undefined ? { resetsAt } : {}) },
});

describe("claude rate_limit_event in the content reader", () => {
  // The status union is closed in the Agent SDK's SDKRateLimitEvent type:
  // "allowed" | "allowed_warning" | "rejected". Only rejection is a limit.
  test("a rejected status is a limit event with the reset time in milliseconds", () => {
    expect(contentEventsOf("claude", event("rejected", 1_700_000_000))).toEqual([
      {
        kind: "limit",
        code: "rate-limit",
        detail: "rate_limit_event status=rejected",
        resetsAt: 1_700_000_000_000,
      },
    ]);
  });

  test("an allowed status is not a limit", () => {
    expect(contentEventsOf("claude", event("allowed"))).toEqual([]);
  });

  test("allowed_warning (past a usage threshold, request still served) is not a limit", () => {
    // Observed live on claude 2.1.263 (2026-09-06): a clean one-word turn
    // carried status=allowed_warning and hcn reported it failed. The
    // request was served; a warning must never fail the turn.
    expect(contentEventsOf("claude", event("allowed_warning", 1_788_682_200))).toEqual([]);
  });

  test("a non-finite or absent reset time is left out, never a broken number", () => {
    expect(contentEventsOf("claude", event("rejected"))).toEqual([
      { kind: "limit", code: "rate-limit", detail: "rate_limit_event status=rejected" },
    ]);
    expect(contentEventsOf("claude", event("rejected", -5))).toEqual([
      { kind: "limit", code: "rate-limit", detail: "rate_limit_event status=rejected" },
    ]);
  });

  test("reset time conversion cannot overflow to Infinity", () => {
    expect(contentEventsOf("claude", event("rejected", Number.MAX_VALUE))).toEqual([
      { kind: "limit", code: "rate-limit", detail: "rate_limit_event status=rejected" },
    ]);
  });

  test("the stream decoder still yields the same failure event, reset time included", () => {
    const events = decodeParsed(
      claudeCode,
      event("rejected", 1_700_000_000),
      freshDecodeState(),
      "",
    );
    expect(events).toEqual([
      {
        kind: "failure",
        class: "rate-limit",
        retryable: true,
        message:
          "Rate limit hit (rate_limit_event status=rejected) - retry after backoff or route to another provider",
        code: "rate-limit",
        resetsAt: 1_700_000_000_000,
      },
    ]);
  });

  test("the execution-layer decoder branches on no harness name", () => {
    const dir = join(import.meta.dirname, "../../src/execution");
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(dir, file), "utf8");
      expect(source, `src/execution/${file} branches on a harness name`).not.toMatch(
        /h\.name === "/,
      );
    }
  });
});
