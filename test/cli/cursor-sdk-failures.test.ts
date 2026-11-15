import { describe, expect, test } from "vitest";
import { command, ndjsonOf, runCliWithFakeSdk } from "./cursor-sdk-fixture.js";

describe.each(["node", "bun"] as const)(
  "%s: typed SDK failures through the built CLI",
  (runtime) => {
    test("an idle interrupt settles not-active without sending work", async () => {
      const result = await runCliWithFakeSdk(
        {
          script: {},
          args: ["session", "cursor", "--json", "--questions", "none"],
          input: [
            { text: command({ op: "interrupt", id: "idle" }) },
            { text: command({ op: "close" }), waitFor: '"kind":"interruption"' },
          ],
        },
        runtime,
      );
      try {
        expect(ndjsonOf(result.stdout)).toContainEqual({
          kind: "interruption",
          id: "idle",
          state: "not-active",
        });
        expect(result.calls.filter((call) => call.phase === "send")).toHaveLength(0);
      } finally {
        result.cleanup();
      }
    });

    test("matched SDK authentication keeps the native subtype through the CLI", async () => {
      const result = await runCliWithFakeSdk(
        {
          script: { openError: { name: "AuthenticationError", message: "Invalid API key" } },
          args: ["run", "cursor", "--json", "--questions", "none", "--prompt", "fixture"],
        },
        runtime,
      );
      try {
        expect(ndjsonOf(result.stdout).filter((event) => event.kind === "failure")).toEqual([
          expect.objectContaining({ class: "auth", authKind: "invalid-key" }),
        ]);
      } finally {
        result.cleanup();
      }
    });

    test("interrupt during SDK open cancels deferred input without inventing a turn or native error", async () => {
      const result = await runCliWithFakeSdk(
        {
          script: { openDelayMs: 200 },
          args: ["session", "cursor", "--json", "--questions", "none"],
          input: [
            { text: command({ op: "send", id: "early", text: "must not run" }) },
            { text: command({ op: "interrupt", id: "stop" }) },
            { text: command({ op: "close" }), waitFor: '"state":"interrupted"' },
          ],
        },
        runtime,
      );
      try {
        const events = ndjsonOf(result.stdout);
        expect(events).toContainEqual({ kind: "interruption", id: "stop", state: "interrupted" });
        expect(
          events.filter((event) =>
            ["error", "failure", "turn", "done"].includes(String(event.kind)),
          ),
        ).toEqual([]);
        expect(result.calls.filter((call) => call.phase === "send")).toEqual([]);
        expect(events.at(-1)).toMatchObject({ kind: "closed", cause: "clean" });
      } finally {
        result.cleanup();
      }
    });

    // Round-5 reuse fix: a GENERIC SDK error (kind native, not
    // RateLimitError) whose message matches Cursor's usage-limit prose
    // classifies through the fallback classifier. The final classified
    // failure must own the limit bookkeeping, so the turn's done and the
    // session's closed report cause "limit" - not "failed"/"clean" and
    // "crash" - on both failure phases.
    for (const [phase, script] of [
      ["open", { openError: { name: "Error", message: "You've hit your usage limit" } }],
      [
        "send",
        { sends: [{ busy: true, errorName: "Error", message: "You've hit your usage limit" }] },
      ],
    ] as const) {
      test(`session ${phase} failure: generic Error with usage-limit text reports cause limit`, async () => {
        const result = await runCliWithFakeSdk(
          {
            script,
            args: ["session", "cursor", "--json", "--questions", "none"],
            input: [
              { text: command({ op: "send", id: "fixture", text: "fixture" }) },
              { text: command({ op: "close" }), waitFor: '"kind":"failure"' },
            ],
          },
          runtime,
        );
        try {
          const events = ndjsonOf(result.stdout);
          expect(events.filter((event) => event.kind === "disposition")).toContainEqual({
            kind: "disposition",
            id: "fixture",
            disposition: "rejected",
            reason: "native-rejected",
          });
          const failures = events.filter((event) => event.kind === "failure");
          expect(failures).toHaveLength(1);
          expect(failures[0]).toMatchObject({ class: "usage-limit", code: "usage-limit" });
          expect(events.filter((event) => event.kind === "done")).toEqual([
            expect.objectContaining({ kind: "done", cause: "limit" }),
          ]);
          // The session-wide limit flag decides the close: a failed open
          // exits nonzero, a refused busy send exits zero, and both closes
          // still read "limit".
          expect(events.at(-1)).toMatchObject({
            kind: "closed",
            cause: "limit",
            ...(phase === "open" ? { exitCode: 1, failure: { class: "usage-limit" } } : {}),
          });
        } finally {
          result.cleanup();
        }
      });
    }

    test("a native cancellation rejection stays rejected through the CLI", async () => {
      const result = await runCliWithFakeSdk(
        {
          script: { sends: [{ holdOpen: true, cancelFails: true, finishOnCancelRejection: true }] },
          args: ["session", "cursor", "--json", "--questions", "none"],
          input: [
            { text: command({ op: "send", id: "live", text: "running" }) },
            { text: command({ op: "interrupt", id: "stop" }), waitFor: '"disposition":"started"' },
            { text: command({ op: "close" }), waitFor: '"state":"rejected"' },
          ],
        },
        runtime,
      );
      try {
        expect(ndjsonOf(result.stdout)).toContainEqual({
          kind: "interruption",
          id: "stop",
          state: "rejected",
          reason: "native-rejected",
        });
      } finally {
        result.cleanup();
      }
    });

    for (const [name, failureClass] of [
      ["AuthenticationError", "auth"],
      ["RateLimitError", "rate-limit"],
      ["NetworkError", "transport"],
    ] as const) {
      for (const mode of ["run", "session"] as const) {
        for (const phase of ["open", "send"] as const) {
          test(`${mode} ${phase}: ${name} keeps its class with opaque prose`, async () => {
            const result = await runCliWithFakeSdk(
              {
                script:
                  phase === "open"
                    ? { openError: { name, message: "opaque SDK rejection" } }
                    : { sends: [{ busy: true, errorName: name, message: "opaque SDK rejection" }] },
                args: [
                  mode,
                  "cursor",
                  "--json",
                  "--questions",
                  "none",
                  ...(mode === "run" ? ["--prompt", "fixture"] : []),
                ],
                ...(mode === "session"
                  ? {
                      input: [
                        { text: command({ op: "send", id: "fixture", text: "fixture" }) },
                        { text: command({ op: "close" }), waitFor: '"kind":"failure"' },
                      ],
                    }
                  : {}),
              },
              runtime,
            );
            try {
              const failures = ndjsonOf(result.stdout).filter((event) => event.kind === "failure");
              expect(failures).toHaveLength(1);
              expect(failures[0]).toMatchObject({ class: failureClass, retryable: true });
              expect(failures[0]?.message).toContain("opaque SDK rejection");
              expect(failures[0]?.authKind).toBeUndefined();
            } finally {
              result.cleanup();
            }
          });
        }
      }
    }
  },
);
