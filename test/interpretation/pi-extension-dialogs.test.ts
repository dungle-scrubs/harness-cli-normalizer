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
  decodePiStructuredQuestion,
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
          allowOther: false,
          allowNotes: false,
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
            allowOther: false,
            allowNotes: false,
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

describe("issue #470: hcn's structured question dialog", () => {
  const channel = piCli.sessionMode?.controls.approvals;
  if (channel?.kind !== "pi-extension-ui" || channel.structuredQuestion === undefined) {
    throw new Error("expected the pi channel to declare the structured question");
  }
  const spec = channel.structuredQuestion;

  const MARKER = "[hcn-question] ";
  const editorDialog = (id: string, prefill: unknown, title = `${MARKER}Pick toppings`): string =>
    JSON.stringify({
      type: "extension_ui_request",
      id,
      method: "editor",
      title,
      prefill: typeof prefill === "string" ? prefill : JSON.stringify(prefill),
    });

  const prefill = (questions: unknown[], extra: Record<string, unknown> = {}): unknown => ({
    v: 1,
    questions,
    ...extra,
  });

  const decoded = (record: unknown) =>
    decodePiStructuredQuestion(
      parse(typeof record === "string" ? record : JSON.stringify(record)),
      spec,
    );

  test("the marker and the format version are descriptor data", () => {
    expect(spec).toEqual({ method: "editor", titleMarker: MARKER, version: 1 });
  });

  test("a marked editor dialog becomes a question proposal", () => {
    const decodedQuestion = decoded(
      editorDialog(
        "dlg-1",
        prefill([
          {
            question: "Pick toppings",
            header: "Pizza",
            options: [{ label: "Cheese", description: "optional" }],
            multiSelect: true,
            allowOther: true,
            allowNotes: true,
          },
        ]),
      ),
    );
    expect(decodedQuestion?.kind).toBe("question");
    if (decodedQuestion?.kind !== "question") throw new Error("expected a question");
    expect(decodedQuestion.dialog).toEqual({
      requestId: "dlg-1",
      proposal: {
        category: "question",
        tool: "editor",
        details: "Pick toppings",
        input: {
          type: "extension_ui_request",
          id: "dlg-1",
          method: "editor",
          title: `${MARKER}Pick toppings`,
          prefill: JSON.stringify(
            prefill([
              {
                question: "Pick toppings",
                header: "Pizza",
                options: [{ label: "Cheese", description: "optional" }],
                multiSelect: true,
                allowOther: true,
                allowNotes: true,
              },
            ]),
          ),
        },
        questions: [
          {
            question: "Pick toppings",
            header: "Pizza",
            multiSelect: true,
            allowOther: true,
            allowNotes: true,
            options: [{ label: "Cheese", description: "optional" }],
          },
        ],
        choices: [
          { id: "answer", label: "Answer", scope: "once" },
          { id: "decline", label: "Decline to answer", scope: "deny" },
        ],
        structured: true,
      },
    });
  });

  test("an absent boolean is false and unknown keys are ignored", () => {
    const decodedQuestion = decoded(
      editorDialog(
        "dlg-1",
        prefill([{ question: "Pick one", options: [{ label: "A" }], extra: 1 }]),
      ),
    );
    if (decodedQuestion?.kind !== "question") throw new Error("expected a question");
    expect(decodedQuestion.dialog.proposal.questions).toEqual([
      {
        question: "Pick one",
        multiSelect: false,
        allowOther: false,
        allowNotes: false,
        options: [{ label: "A" }],
      },
    ]);
  });

  test("a question with no options is free text and must allow other text", () => {
    const decodedQuestion = decoded(
      editorDialog("dlg-1", prefill([{ question: "Say it", allowOther: true }])),
    );
    if (decodedQuestion?.kind !== "question") throw new Error("expected a question");
    expect(decodedQuestion.dialog.proposal.questions).toEqual([
      {
        question: "Say it",
        multiSelect: false,
        allowOther: true,
        allowNotes: false,
        freeText: true,
        options: [],
      },
    ]);
    const refused = decoded(editorDialog("dlg-2", prefill([{ question: "Say it" }])));
    expect(refused?.kind).toBe("invalid");
  });

  test("an unmarked editor dialog is not a structured question", () => {
    expect(decoded(editorDialog("dlg-1", prefill([]), "Pick toppings"))).toBeNull();
    expect(
      decoded({
        type: "extension_ui_request",
        id: "dlg-1",
        method: "select",
        title: `${MARKER}Pick toppings`,
        options: ["A"],
      }),
    ).toBeNull();
  });

  test.each([
    ["prefill that is not JSON", "{not json"],
    ["prefill that is not an object", "[1,2]"],
    ["a missing version", JSON.stringify({ questions: [{ question: "q" }] })],
    ["the wrong version", JSON.stringify({ v: 2, questions: [{ question: "q" }] })],
    ["no questions", JSON.stringify({ v: 1, questions: [] })],
    ["questions that are not an array", JSON.stringify({ v: 1, questions: {} })],
    [
      "too many questions",
      JSON.stringify({
        v: 1,
        questions: Array.from({ length: 17 }, (_entry, index) => ({
          question: `q${index}`,
          options: [{ label: "A" }],
        })),
      }),
    ],
    [
      "too many options",
      JSON.stringify({
        v: 1,
        questions: [
          {
            question: "q",
            options: Array.from({ length: 33 }, (_entry, index) => ({ label: `L${index}` })),
          },
        ],
      }),
    ],
    ["an empty question text", JSON.stringify({ v: 1, questions: [{ question: "" }] })],
    [
      "a duplicate question text",
      JSON.stringify({ v: 1, questions: [{ question: "q" }, { question: "q" }] }),
    ],
    [
      "a duplicate option label",
      JSON.stringify({
        v: 1,
        questions: [{ question: "q", options: [{ label: "A" }, { label: "A" }] }],
      }),
    ],
    [
      "an empty option label",
      JSON.stringify({ v: 1, questions: [{ question: "q", options: [{ label: "" }] }] }),
    ],
    [
      "a boolean that is not a boolean",
      JSON.stringify({
        v: 1,
        questions: [{ question: "q", options: [{ label: "A" }], multiSelect: "yes" }],
      }),
    ],
  ])("an invalid prefill is reported, never half-decoded: %s", (_label, prefillText) => {
    const decodedQuestion = decoded({
      type: "extension_ui_request",
      id: "dlg-1",
      method: "editor",
      title: `${MARKER}Pick toppings`,
      prefill: prefillText,
    });
    expect(decodedQuestion?.kind).toBe("invalid");
    if (decodedQuestion?.kind !== "invalid") throw new Error("expected an invalid prefill");
    expect(decodedQuestion.requestId).toBe("dlg-1");
    expect(decodedQuestion.message).toContain("dlg-1");
    expect(decodedQuestion.message).toContain("hcn-question prefill is invalid");
  });

  test("a prefill that is not text is an invalid prefill", () => {
    const decodedQuestion = decoded({
      type: "extension_ui_request",
      id: "dlg-1",
      method: "editor",
      title: `${MARKER}Pick toppings`,
      prefill: 7,
    });
    expect(decodedQuestion?.kind).toBe("invalid");
  });

  test("the session record forwards the marked dialog and reports an invalid prefill", () => {
    const record = decodeSessionRecord(
      piCli,
      parse(editorDialog("dlg-1", prefill([{ question: "q", options: [{ label: "A" }] }]))),
    );
    expect(record).toMatchObject({ kind: "approval-request", requestId: "dlg-1" });
    const invalid = decodeSessionRecord(piCli, parse(editorDialog("dlg-2", "{not json")));
    expect(invalid).toMatchObject({ kind: "approval-invalid", requestId: "dlg-2" });
  });
});

describe("issue #470: answering a structured question", () => {
  const channel = piCli.sessionMode?.controls.approvals;
  if (channel?.kind !== "pi-extension-ui" || channel.structuredQuestion === undefined) {
    throw new Error("expected the pi channel to declare the structured question");
  }
  const spec = channel.structuredQuestion;
  const MARKER = "[hcn-question] ";
  const record = {
    type: "extension_ui_request",
    id: "dlg-1",
    method: "editor",
    title: `${MARKER}Pick toppings`,
    prefill: JSON.stringify({
      v: 1,
      questions: [
        {
          question: "Pick toppings",
          header: "Pizza",
          options: [{ label: "Cheese" }, { label: "Olives" }],
          multiSelect: true,
          allowOther: true,
          allowNotes: true,
        },
        {
          question: "Pick a size",
          options: [{ label: "Small" }, { label: "Large" }],
        },
      ],
    }),
  };
  const decoded = decodePiStructuredQuestion(parse(JSON.stringify(record)), spec);
  if (decoded?.kind !== "question") throw new Error("expected a decoded question");
  const proposal = decoded.dialog.proposal;

  const decide = (decision: Parameters<typeof applyPiExtensionDialogDecision>[2]) =>
    applyPiExtensionDialogDecision("dlg-1", proposal, decision);

  const editorValue = (line: string): unknown => {
    const reply = JSON.parse(line) as { value?: string };
    return JSON.parse(String(reply.value)) as unknown;
  };

  test("two checkboxes, an other text and a note become the whole question set", () => {
    const applied = decide({
      choiceId: "answer",
      answers: { "Pick toppings": ["Cheese", "Olives", "Anchovies"], "Pick a size": "Small" },
      notes: { "Pick toppings": "no anchovies" },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("expected an accepted decision");
    expect(JSON.parse(applied.line)).toEqual({
      type: "extension_ui_response",
      id: "dlg-1",
      value: JSON.stringify({
        answers: { "Pick toppings": ["Cheese", "Olives", "Anchovies"], "Pick a size": "Small" },
        notes: { "Pick toppings": "no anchovies" },
      }),
    });
  });

  test("the reply holds the host's own values, with no notes key when there are none", () => {
    const applied = decide({
      choiceId: "answer",
      answers: { "Pick a size": ["Large"] },
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error("expected an accepted decision");
    expect(editorValue(applied.line)).toEqual({ answers: { "Pick a size": ["Large"] } });
  });

  test("a decline cancels the dialog", () => {
    expect(decide({ choiceId: "decline" })).toEqual({
      ok: true,
      line: '{"type":"extension_ui_response","id":"dlg-1","cancelled":true}\n',
    });
  });

  test.each([
    ["an unknown choice", { choiceId: "nope" }, "unknown-choice"],
    ["no answers", { choiceId: "answer" }, "invalid-answers"],
    ["an empty answer map", { choiceId: "answer", answers: {} }, "invalid-answers"],
    [
      "an answer keyed by an unknown question",
      { choiceId: "answer", answers: { Nope: "Cheese" } },
      "invalid-answers",
    ],
    [
      "a label that was not offered",
      { choiceId: "answer", answers: { "Pick a size": "Huge" } },
      "invalid-answers",
    ],
    ["an empty label", { choiceId: "answer", answers: { "Pick a size": "" } }, "invalid-answers"],
    [
      "two answers on a single-select question",
      { choiceId: "answer", answers: { "Pick a size": ["Small", "Large"] } },
      "invalid-answers",
    ],
    ["an empty array", { choiceId: "answer", answers: { "Pick toppings": [] } }, "invalid-answers"],
    [
      "an answer on a decline",
      { choiceId: "decline", answers: { "Pick a size": "Small" } },
      "invalid-answers",
    ],
    [
      "notes on a decline",
      { choiceId: "decline", notes: { "Pick toppings": "no" } },
      "invalid-notes",
    ],
    [
      "a message on an answer",
      { choiceId: "answer", answers: { "Pick a size": "Small" }, message: "hi" },
      "invalid-message",
    ],
    ["a message on a decline", { choiceId: "decline", message: "no" }, "invalid-message"],
    [
      "notes on a question that allows none",
      { choiceId: "answer", answers: { "Pick a size": "Small" }, notes: { "Pick a size": "no" } },
      "invalid-notes",
    ],
    [
      "notes on an unanswered question",
      {
        choiceId: "answer",
        answers: { "Pick a size": "Small" },
        notes: { "Pick toppings": "no" },
      },
      "invalid-notes",
    ],
    [
      "notes on an unknown question",
      { choiceId: "answer", answers: { "Pick a size": "Small" }, notes: { Nope: "no" } },
      "invalid-notes",
    ],
  ])("%s is refused", (_label, decision, reason) => {
    expect(decide(decision as Parameters<typeof applyPiExtensionDialogDecision>[2])).toEqual({
      ok: false,
      reason,
    });
  });
});
