/**
 * Issue #426: the pure half of live-session controls - descriptor facts,
 * their capability projection, the native encodings and the decoded
 * records the runner settles on. Wire shapes come from the pi 1.4.0 and
 * claude 2.1.312 captures named in the issue's evidence.
 */
import { describe, expect, test } from "vitest";
import { capabilitiesOf, sessionControlsOf } from "../../src/interpretation/capabilities.js";
import {
  correlatesByInputUuid,
  decodeSessionRecord,
  encodeSessionInput,
  encodeSessionInterrupt,
  publishesTurnOnRunEvidence,
  readInputUuids,
  SessionInputRefusalError,
} from "../../src/interpretation/session-input.js";
import { antigravityCli } from "../../src/knowledge/antigravity.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";
import { codexCli } from "../../src/knowledge/codex.js";
import { cursorCli } from "../../src/knowledge/cursor.js";
import { type HarnessDescriptor, SESSION_DELIVERIES } from "../../src/knowledge/descriptor.js";
import { museCode } from "../../src/knowledge/muse.js";
import { piCli } from "../../src/knowledge/pi.js";
import { popeyeCli } from "../../src/knowledge/popeye.js";

const SESSION_HARNESSES: readonly HarnessDescriptor[] = [
  claudeCode,
  piCli,
  codexCli,
  antigravityCli,
  popeyeCli,
];

describe("session controls are descriptor facts", () => {
  test("the supported matrix", () => {
    expect(
      Object.fromEntries(SESSION_HARNESSES.map((h) => [h.name, sessionControlsOf(h)])),
    ).toEqual({
      [claudeCode.name]: { deliveryModes: ["queue", "steer"], interrupt: { supported: false } },
      [piCli.name]: {
        deliveryModes: ["queue", "steer"],
        interrupt: { supported: true, toolCancellation: "best-effort" },
      },
      [codexCli.name]: { deliveryModes: ["steer"], interrupt: { supported: false } },
      [antigravityCli.name]: { deliveryModes: [], interrupt: { supported: false } },
      [popeyeCli.name]: { deliveryModes: [], interrupt: { supported: false } },
    });
  });

  test("harnesses with no session report no controls", () => {
    for (const h of [cursorCli, museCode]) {
      expect(h.sessionMode).toBeNull();
      expect(sessionControlsOf(h)).toBeNull();
      expect(capabilitiesOf(h, "", "headless-session").sessionControls).toBeNull();
    }
  });

  test("capabilities carry the controls without degrading for an uncurated model", () => {
    expect(
      capabilitiesOf(piCli, "not-a-curated-model", "headless-session").sessionControls,
    ).toEqual(sessionControlsOf(piCli));
  });

  test.each(SESSION_HARNESSES.map((h) => [h.name, h] as const))(
    "%s: the encoder accepts exactly the delivery modes its descriptor declares",
    (_name, h) => {
      const input = h.sessionMode?.input;
      if (input === undefined) throw new Error("session harness without input");
      for (const delivery of SESSION_DELIVERIES) {
        const encode = () =>
          encodeSessionInput(input, "text", {
            busy: true,
            id: "x",
            delivery,
            sessionId: "s",
            activeTurnId: "t",
          });
        if (h.sessionMode?.controls.delivery.includes(delivery)) expect(encode).not.toThrow();
        else
          expect(encode).toThrowError(expect.objectContaining({ issue: "unsupported-delivery" }));
      }
    },
  );

  test.each(SESSION_HARNESSES.map((h) => [h.name, h] as const))(
    "%s: the interrupt encoder agrees with the descriptor",
    (_name, h) => {
      const input = h.sessionMode?.input;
      if (input === undefined) throw new Error("session harness without input");
      const encode = () => encodeSessionInterrupt(input, "1");
      if (h.sessionMode?.controls.interrupt !== null) expect(encode).not.toThrow();
      else expect(encode).toThrowError(SessionInputRefusalError);
    },
  );
});

describe("native encodings", () => {
  test("pi interrupt is a correlated abort carrying only the internal token", () => {
    expect(encodeSessionInterrupt({ kind: "pi-rpc-prompt" }, "42")).toBe(
      '{"id":"hcn-interrupt:42","type":"abort"}\n',
    );
  });

  test("claude stamps the uuid only when asked; omitted delivery stays byte-identical", () => {
    const omitted = encodeSessionInput({ kind: "claude-sdk-user-message" }, "hi", {
      busy: true,
      id: "a",
    });
    expect(omitted).toBe(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n',
    );
    expect(
      JSON.parse(
        encodeSessionInput({ kind: "claude-sdk-user-message" }, "hi", {
          busy: true,
          id: "a",
          delivery: "steer",
          uuid: "dd234fac-d306-419f-8829-56b7be9a4b4f",
        }),
      ),
    ).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
      priority: "next",
      uuid: "dd234fac-d306-419f-8829-56b7be9a4b4f",
    });
  });
});

describe("decoded control records", () => {
  test.each(["started", "queued", "handled"] as const)(
    "pi prompt receipt carries native disposition %s",
    (disposition) => {
      expect(
        decodeSessionRecord(piCli, {
          id: "hcn-send:h1",
          type: "response",
          command: "prompt",
          success: true,
          data: { disposition },
        }),
      ).toEqual({ inputId: "h1", kind: "command-accepted", nativeDisposition: disposition });
    },
  );

  test("an unknown pi disposition is not invented", () => {
    expect(
      decodeSessionRecord(piCli, {
        id: "hcn-send:h1",
        type: "response",
        command: "prompt",
        success: true,
        data: { disposition: "promoted" },
      }),
    ).toEqual({ inputId: "h1", kind: "command-accepted" });
  });

  test("pi abort responses decode as interrupt answers, never as send receipts", () => {
    expect(
      decodeSessionRecord(piCli, {
        id: "hcn-interrupt:7",
        type: "response",
        command: "abort",
        success: true,
      }),
    ).toEqual({ kind: "interrupt-answered", token: "7", accepted: true });
    expect(
      decodeSessionRecord(piCli, {
        id: "hcn-interrupt:7",
        type: "response",
        command: "abort",
        success: false,
        error: "no",
      }),
    ).toEqual({
      kind: "interrupt-answered",
      token: "7",
      accepted: false,
      message: 'rpc command failed: "abort" - "no"',
    });
    // An abort hcn did not write is protocol bookkeeping.
    expect(
      decodeSessionRecord(piCli, { id: "ab1", type: "response", command: "abort", success: true }),
    ).toEqual({ kind: "ignored" });
  });

  test("pi agent_settled reports an aborted run, and only then", () => {
    expect(decodeSessionRecord(piCli, { type: "agent_settled", aborted: true })).toEqual({
      kind: "turn-end",
      isError: false,
      aborted: true,
    });
    expect(decodeSessionRecord(piCli, { type: "agent_settled", aborted: false })).toEqual({
      kind: "turn-end",
      isError: false,
    });
  });

  test("claude input uuids come from turn-level records; inner and background frames name none", () => {
    expect(
      readInputUuids(claudeCode, {
        type: "result",
        user_message_uuid: "a",
        user_message_uuids: ["a", "b"],
      }),
    ).toEqual(["a", "b"]);
    expect(
      readInputUuids(claudeCode, {
        type: "system",
        subtype: "thinking_tokens",
        user_message_uuid: "a",
      }),
    ).toEqual(["a"]);
    expect(
      readInputUuids(claudeCode, {
        type: "result",
        origin: { kind: "task-notification", producer: "session-task" },
      }),
    ).toEqual([]);
    expect(readInputUuids(piCli, { user_message_uuids: ["a"] })).toEqual([]);
  });
});

describe("protocol facts the runner branches on", () => {
  test("only claude correlates turns by native input uuid; only pi publishes turns on run evidence", () => {
    const kinds = (predicate: (kind: never) => boolean) =>
      SESSION_HARNESSES.filter(
        (h) => h.sessionMode !== null && predicate(h.sessionMode.input.kind as never),
      ).map((h) => h.name);
    expect(kinds(correlatesByInputUuid)).toEqual([claudeCode.name]);
    expect(kinds(publishesTurnOnRunEvidence)).toEqual([piCli.name]);
  });
});
