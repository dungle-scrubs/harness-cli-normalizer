/**
 * Issue #469: the pure layer of pi's extension UI channel - decoding an
 * `extension_ui_request` into the normalized approval proposal, and a
 * host decision back into the native `extension_ui_response`. The shapes
 * come from pi 1.4.0's rpc mode: the request carries the dialog method,
 * the title, the offered options and an optional timeout; the reply
 * carries the chosen value or `cancelled: true`.
 */
import { describe, expect, test } from "vitest";
import {
  applyPiExtensionDialogDecision,
  decodePiExtensionDialog,
  encodePiExtensionCancel,
  encodePiExtensionResponse,
} from "../../src/interpretation/pi-extension-dialogs.js";
import { decodeSessionRecord } from "../../src/interpretation/session-input.js";
import { piCli } from "../../src/knowledge/pi.js";

const TITLE = "Which one?";
const REQUEST = {
  type: "extension_ui_request",
  id: "dlg-1",
  method: "select",
  title: TITLE,
  options: ["1. A", "1. B"],
};

const DIALOGS = ["select", "input"] as const;

const parse = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

const decodedRequest = () => {
  const decoded = decodePiExtensionDialog(parse(JSON.stringify(REQUEST)), DIALOGS);
  if (decoded === null) throw new Error("expected a decoded dialog");
  return decoded;
};

describe("issue #469: decoding an extension UI request", () => {
  test("a select dialog becomes a question proposal", () => {
    const decoded = decodedRequest();
    expect(decoded.requestId).toBe("dlg-1");
    expect(decoded.timeoutMs).toBeUndefined();
    expect(decoded.proposal).toEqual({
      category: "question",
      tool: "select",
      details: TITLE,
      input: REQUEST,
      questions: [
        {
          question: TITLE,
          multiSelect: false,
          options: [{ label: "1. A" }, { label: "1. B" }],
        },
      ],
      choices: [
        { id: "answer", label: "Answer", scope: "once" },
        { id: "decline", label: "Decline to answer", scope: "deny" },
      ],
    });
  });

  test("a dialog with a timeout carries it", () => {
    const decoded = decodePiExtensionDialog(
      parse(JSON.stringify({ ...REQUEST, timeout: 5000 })),
      DIALOGS,
    );
    expect(decoded?.timeoutMs).toBe(5000);
  });

  test.each([
    ["another method", { ...REQUEST, method: "confirm" }],
    ["a missing method", { ...REQUEST, method: undefined }],
    ["a missing id", { ...REQUEST, id: undefined }],
    ["an empty id", { ...REQUEST, id: "" }],
    ["a non-string id", { ...REQUEST, id: 7 }],
    ["a missing title", { ...REQUEST, title: undefined }],
    ["a non-string title", { ...REQUEST, title: 7 }],
    ["missing options", { ...REQUEST, options: undefined }],
    ["empty options", { ...REQUEST, options: [] }],
    ["a non-string option", { ...REQUEST, options: ["1. A", 7] }],
    ["an empty option", { ...REQUEST, options: ["1. A", ""] }],
    ["options that are not an array", { ...REQUEST, options: "1. A" }],
    ["another record type", { ...REQUEST, type: "response" }],
  ])("a malformed record is ignored: %s", (_label, record) => {
    expect(decodePiExtensionDialog(parse(JSON.stringify(record)), DIALOGS)).toBeNull();
  });

  test.each([
    ["zero", 0],
    ["a negative number", -1],
    ["a non-finite number", Number.POSITIVE_INFINITY],
    ["a string", "5000"],
  ])("a timeout that is %s is not carried", (_label, timeout) => {
    const decoded = decodePiExtensionDialog(
      parse(JSON.stringify({ ...REQUEST, timeout })),
      DIALOGS,
    );
    expect(decoded?.timeoutMs).toBeUndefined();
  });
});

describe("issue #469: the session record", () => {
  test("a select dialog becomes an approval-request record", () => {
    expect(decodeSessionRecord(piCli, parse(JSON.stringify(REQUEST)))).toEqual({
      kind: "approval-request",
      requestId: "dlg-1",
      proposal: decodedRequest().proposal,
    });
  });

  test("a dialog with a timeout carries it on the record", () => {
    const record = decodeSessionRecord(piCli, parse(JSON.stringify({ ...REQUEST, timeout: 5000 })));
    expect(record).toMatchObject({ kind: "approval-request", timeoutMs: 5000 });
  });

  test("another extension UI record stays content", () => {
    expect(
      decodeSessionRecord(piCli, parse(JSON.stringify({ ...REQUEST, method: "confirm" }))),
    ).toEqual({ kind: "content" });
  });
});

describe("issue #469: the native reply lines", () => {
  test("an answer carries the chosen value", () => {
    expect(encodePiExtensionResponse("dlg-1", "1. A")).toBe(
      '{"type":"extension_ui_response","id":"dlg-1","value":"1. A"}\n',
    );
  });

  test("a decline cancels the dialog", () => {
    expect(encodePiExtensionCancel("dlg-1")).toBe(
      '{"type":"extension_ui_response","id":"dlg-1","cancelled":true}\n',
    );
  });
});

describe("issue #469: applying a decision", () => {
  const decide = (decision: Parameters<typeof applyPiExtensionDialogDecision>[2]) =>
    applyPiExtensionDialogDecision("dlg-1", decodedRequest().proposal, decision);

  test("an answer writes the offered option", () => {
    expect(decide({ choiceId: "answer", answers: { [TITLE]: "1. A" } })).toEqual({
      ok: true,
      line: '{"type":"extension_ui_response","id":"dlg-1","value":"1. A"}\n',
    });
  });

  test("an array of one offered option answers the dialog", () => {
    expect(decide({ choiceId: "answer", answers: { [TITLE]: ["1. B"] } })).toEqual({
      ok: true,
      line: '{"type":"extension_ui_response","id":"dlg-1","value":"1. B"}\n',
    });
  });

  test("a decline cancels the dialog", () => {
    expect(decide({ choiceId: "decline" })).toEqual({
      ok: true,
      line: '{"type":"extension_ui_response","id":"dlg-1","cancelled":true}\n',
    });
  });

  test.each([
    ["an unknown choice", { choiceId: "nope" }, "unknown-choice"],
    [
      "an option that was not offered",
      { choiceId: "answer", answers: { [TITLE]: "2. C" } },
      "invalid-answers",
    ],
    [
      "two answers",
      { choiceId: "answer", answers: { [TITLE]: "1. A", [`${TITLE} 2`]: "1. B" } },
      "invalid-answers",
    ],
    [
      "an array of two",
      { choiceId: "answer", answers: { [TITLE]: ["1. A", "1. B"] } },
      "invalid-answers",
    ],
    ["an empty array", { choiceId: "answer", answers: { [TITLE]: [] } }, "invalid-answers"],
    ["no answers", { choiceId: "answer" }, "invalid-answers"],
    ["an empty answer map", { choiceId: "answer", answers: {} }, "invalid-answers"],
    [
      "an answer keyed by another question",
      { choiceId: "answer", answers: { Other: "1. A" } },
      "invalid-answers",
    ],
    [
      "a message on an answer",
      { choiceId: "answer", message: "hi", answers: { [TITLE]: "1. A" } },
      "invalid-message",
    ],
    [
      "answers on a decline",
      { choiceId: "decline", answers: { [TITLE]: "1. A" } },
      "invalid-answers",
    ],
    ["a message on a decline", { choiceId: "decline", message: "no" }, "invalid-message"],
  ])("%s is refused", (_label, decision, reason) => {
    expect(decide(decision)).toEqual({ ok: false, reason });
  });
});

describe("issue #469: the free-text input dialog", () => {
  const INPUT = {
    type: "extension_ui_request",
    id: "dlg-2",
    method: "input",
    title: TITLE,
    placeholder: "Type your answer",
  };
  const decodedInput = () => {
    const decoded = decodePiExtensionDialog(parse(JSON.stringify(INPUT)), DIALOGS);
    if (decoded === null) throw new Error("expected a decoded dialog");
    return decoded;
  };
  const decide = (decision: Parameters<typeof applyPiExtensionDialogDecision>[2]) =>
    applyPiExtensionDialogDecision("dlg-2", decodedInput().proposal, decision);

  test("decodes into a free-text question with the native placeholder", () => {
    expect(decodedInput()).toEqual({
      requestId: "dlg-2",
      proposal: {
        category: "question",
        tool: "input",
        details: TITLE,
        input: INPUT,
        questions: [
          {
            question: TITLE,
            multiSelect: false,
            freeText: true,
            placeholder: "Type your answer",
            options: [],
          },
        ],
        choices: [
          { id: "answer", label: "Answer", scope: "once" },
          { id: "decline", label: "Decline to answer", scope: "deny" },
        ],
      },
    });
  });

  test("a missing or empty placeholder is left out", () => {
    for (const placeholder of [undefined, ""]) {
      const decoded = decodePiExtensionDialog(
        parse(JSON.stringify({ ...INPUT, placeholder })),
        DIALOGS,
      );
      expect(decoded?.proposal.questions?.[0]).not.toHaveProperty("placeholder");
    }
  });

  test("a method the channel does not name is ignored", () => {
    expect(decodePiExtensionDialog(parse(JSON.stringify(INPUT)), ["select"])).toBeNull();
    expect(decodePiExtensionDialog(parse(JSON.stringify(REQUEST)), ["input"])).toBeNull();
  });

  test("any non-empty text is the answer", () => {
    expect(decide({ choiceId: "answer", answers: { [TITLE]: "my own words" } })).toEqual({
      ok: true,
      line: '{"type":"extension_ui_response","id":"dlg-2","value":"my own words"}\n',
    });
    expect(decide({ choiceId: "answer", answers: { [TITLE]: ["one item"] } })).toEqual({
      ok: true,
      line: '{"type":"extension_ui_response","id":"dlg-2","value":"one item"}\n',
    });
  });

  test("a decline cancels it", () => {
    expect(decide({ choiceId: "decline" })).toEqual({
      ok: true,
      line: '{"type":"extension_ui_response","id":"dlg-2","cancelled":true}\n',
    });
  });

  test.each([
    ["an empty text", { choiceId: "answer", answers: { [TITLE]: "" } }, "invalid-answers"],
    ["two texts", { choiceId: "answer", answers: { [TITLE]: ["a", "b"] } }, "invalid-answers"],
    ["another question", { choiceId: "answer", answers: { Other: "a" } }, "invalid-answers"],
    ["a message on a decline", { choiceId: "decline", message: "no" }, "invalid-message"],
  ])("%s is refused", (_label, decision, reason) => {
    expect(decide(decision)).toEqual({ ok: false, reason });
  });

  test("the session record forwards pi's input dialog", () => {
    expect(decodeSessionRecord(piCli, parse(JSON.stringify(INPUT)))).toMatchObject({
      kind: "approval-request",
      requestId: "dlg-2",
      proposal: { tool: "input" },
    });
  });
});
