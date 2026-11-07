/**
 * Issue #454/#455: the pure layer of the Claude session permission
 * channel - decoding `can_use_tool` control requests into the normalized
 * approval-request proposal, and a host decision back into the native
 * `control_response`. The shapes come from the 2.1.319 probe
 * (claude-controls.json, claude-controls-cancel.json): ordinary tools
 * carry description/permission_suggestions, AskUserQuestion and
 * ExitPlanMode carry requires_user_interaction instead. Suggestion
 * objects follow Claude's documented PermissionUpdate / PermissionRule
 * shapes (review round 1, F4). Expected default messages are literals,
 * never production imports, so a mutant that empties them dies here
 * (review round 1, F11).
 */
import { describe, expect, test } from "vitest";
import {
  applySessionApprovalDecision,
  decodeClaudePermissionRequest,
  encodeClaudeControlResponse,
  type SessionApprovalDecision,
  type SessionApprovalProposal,
} from "../../src/interpretation/session-approvals.js";
import { decodeSessionRecord } from "../../src/interpretation/session-input.js";
import { claudeCode } from "../../src/knowledge/claude-code.js";

const controlRequest = (request: Record<string, unknown>, requestId = "req-1"): string =>
  JSON.stringify({ type: "control_request", request_id: requestId, request });

// The documented Claude PermissionUpdate shapes: suggestions are objects
// with a type, a destination, an allow/deny behavior, and addRules rules
// as {toolName, ruleContent?} objects - never strings.
const SET_MODE_SUGGESTION = { type: "setMode", mode: "acceptEdits", destination: "session" };
const ADD_RULES_SUGGESTION = {
  type: "addRules",
  behavior: "allow",
  destination: "session",
  rules: [{ toolName: "Bash", ruleContent: "git status" }, { toolName: "Read" }],
};

const WRITE_REQUEST = {
  subtype: "can_use_tool",
  tool_name: "Write",
  display_name: "Write",
  input: { file_path: "/tmp/x.txt", content: "x\n" },
  description: "Write file to /tmp/x.txt",
  tool_use_id: "toolu_1",
  permission_suggestions: [SET_MODE_SUGGESTION],
};

const parse = (line: string): Record<string, unknown> =>
  JSON.parse(line) as Record<string, unknown>;

describe("issue #454: decoding can_use_tool requests", () => {
  test("an ordinary tool request becomes a tool proposal with the native suggestions", () => {
    const decoded = decodeClaudePermissionRequest(parse(controlRequest(WRITE_REQUEST)));
    if (decoded === null) throw new Error("expected a decoded request");
    expect(decoded.requestId).toBe("req-1");
    expect(decoded.proposal).toEqual({
      category: "tool",
      tool: "Write",
      details: "Write file to /tmp/x.txt",
      input: WRITE_REQUEST.input,
      choices: [
        { id: "allow", label: "Allow", scope: "once" },
        {
          id: "suggestion-1",
          label: "Allow, and accept edits for this session",
          scope: "session",
          update: SET_MODE_SUGGESTION,
        },
        { id: "deny", label: "Deny", scope: "deny" },
      ],
    });
  });

  test("details falls back to the display name when no description rides the request", () => {
    const decoded = decodeClaudePermissionRequest(
      parse(controlRequest({ ...WRITE_REQUEST, description: undefined, display_name: "Edit" })),
    );
    expect(decoded?.proposal.details).toBe("Edit");
  });

  test("suggestions that do not widen the session are not offered", () => {
    const decoded = decodeClaudePermissionRequest(
      parse(
        controlRequest({
          ...WRITE_REQUEST,
          permission_suggestions: [
            { ...ADD_RULES_SUGGESTION, destination: "persisted" },
            { type: "setMode", mode: "default", destination: "local" },
            // behavior deny on a session destination: never a choice.
            { ...ADD_RULES_SUGGESTION, behavior: "deny" },
            // addRules without an explicit allow behavior: not offered.
            { type: "addRules", destination: "session", rules: [{ toolName: "Bash" }] },
            // Narrowing update types are never a choice, whatever
            // behavior they carry (review round 2, G5).
            {
              type: "removeRules",
              behavior: "allow",
              destination: "session",
              rules: [{ toolName: "Bash" }],
            },
            {
              type: "replaceRules",
              behavior: "allow",
              destination: "session",
              rules: [{ toolName: "Bash" }],
            },
            { type: "removeDirectories", behavior: "allow", destination: "session" },
          ],
        }),
      ),
    );
    expect(decoded?.proposal.choices.map((choice) => choice.id)).toEqual(["allow", "deny"]);
  });

  test("an addDirectories suggestion widens the session and is offered (review round 2, G5)", () => {
    const addDirectories = {
      type: "addDirectories",
      destination: "session",
      directories: ["/outside/working/dir"],
    };
    const decoded = decodeClaudePermissionRequest(
      parse(controlRequest({ ...WRITE_REQUEST, permission_suggestions: [addDirectories] })),
    );
    expect(decoded?.proposal.choices[1]).toEqual({
      id: "suggestion-1",
      // addDirectories has no rules to name, so the label stays generic
      // while still naming the session scope it grants.
      label: "Allow, and apply the suggested permission for this session",
      scope: "session",
      update: addDirectories,
    });
  });

  test("an addRules session suggestion renders its rules and carries the native update (review F4)", () => {
    const decoded = decodeClaudePermissionRequest(
      parse(controlRequest({ ...WRITE_REQUEST, permission_suggestions: [ADD_RULES_SUGGESTION] })),
    );
    expect(decoded?.proposal.choices[1]).toEqual({
      id: "suggestion-1",
      // Tool or Tool(ruleContent), joined with ", ".
      label: "Allow, and always allow Bash(git status), Read for this session",
      scope: "session",
      update: ADD_RULES_SUGGESTION,
    });
    // A rules array of non-objects keeps a generic label instead of
    // stringifying the entries.
    const malformed = decodeClaudePermissionRequest(
      parse(
        controlRequest({
          ...WRITE_REQUEST,
          permission_suggestions: [
            {
              type: "addRules",
              behavior: "allow",
              destination: "session",
              rules: ["Bash(git status)"],
            },
          ],
        }),
      ),
    );
    expect(malformed?.proposal.choices[1]?.label).toBe(
      "Allow, and apply the suggested permission for this session",
    );
  });

  test("a request with no suggestions offers allow and deny only", () => {
    const decoded = decodeClaudePermissionRequest(
      parse(controlRequest({ ...WRITE_REQUEST, permission_suggestions: undefined })),
    );
    expect(decoded?.proposal.choices.map((choice) => choice.id)).toEqual(["allow", "deny"]);
  });

  test("AskUserQuestion becomes a question proposal with normalized questions", () => {
    const questions = [
      {
        question: "Which database should the service use?",
        header: "Database",
        multiSelect: false,
        options: [
          { label: "Postgres", description: "server" },
          { label: "SQLite", description: "file" },
        ],
      },
    ];
    const decoded = decodeClaudePermissionRequest(
      parse(
        controlRequest({
          subtype: "can_use_tool",
          tool_name: "AskUserQuestion",
          display_name: "AskUserQuestion",
          input: { questions },
          tool_use_id: "toolu_2",
          requires_user_interaction: true,
        }),
      ),
    );
    expect(decoded?.proposal).toEqual({
      category: "question",
      tool: "AskUserQuestion",
      details: "AskUserQuestion",
      input: { questions },
      questions,
      choices: [
        { id: "answer", label: "Answer", scope: "once" },
        { id: "decline", label: "Decline to answer", scope: "deny" },
      ],
    });
  });

  test("ExitPlanMode becomes a plan proposal carrying the plan text", () => {
    const decoded = decodeClaudePermissionRequest(
      parse(
        controlRequest({
          subtype: "can_use_tool",
          tool_name: "ExitPlanMode",
          display_name: "ExitPlanMode",
          input: { plan: "1. Write probe.txt" },
          tool_use_id: "toolu_3",
          requires_user_interaction: true,
        }),
      ),
    );
    expect(decoded?.proposal).toEqual({
      category: "plan",
      tool: "ExitPlanMode",
      details: "ExitPlanMode",
      input: { plan: "1. Write probe.txt" },
      plan: "1. Write probe.txt",
      choices: [
        { id: "approve", label: "Approve", scope: "once" },
        { id: "deny", label: "Deny", scope: "deny" },
      ],
    });
  });

  test("malformed records decode to null and the record reads ignored", () => {
    for (const malformed of [
      controlRequest({ subtype: "interrupt" }),
      controlRequest({ subtype: "can_use_tool" }),
      // Another control-request subtype that happens to carry tool fields
      // never opens the permission channel (review round 1, F8).
      controlRequest({
        subtype: "hook_callback",
        tool_name: "Write",
        input: { file_path: "/tmp/x.txt" },
      }),
      controlRequest({ subtype: "can_use_tool", tool_name: 7, input: {} }),
      JSON.stringify({ type: "control_request", request_id: "req-1", request: "nope" }),
      JSON.stringify({
        type: "control_request",
        request: { subtype: "can_use_tool", tool_name: "Write", input: {} },
      }),
    ]) {
      const record = decodeSessionRecord(claudeCode, parse(malformed));
      expect(record).toEqual({ kind: "ignored" });
    }
  });

  test("decodeSessionRecord names the request and the native cancel", () => {
    const record = decodeSessionRecord(claudeCode, parse(controlRequest(WRITE_REQUEST, "req-9")));
    expect(record).toMatchObject({ kind: "approval-request", requestId: "req-9" });
    const cancel = decodeSessionRecord(
      claudeCode,
      parse(JSON.stringify({ type: "control_cancel_request", request_id: "req-9" })),
    );
    expect(cancel).toEqual({ kind: "approval-cancelled", requestId: "req-9" });
  });
});

const proposalOf = (line: string): SessionApprovalProposal => {
  const decoded = decodeClaudePermissionRequest(parse(line));
  if (decoded === null) throw new Error("expected a decoded request");
  return decoded.proposal;
};

describe("issue #454/#455: applying host decisions", () => {
  const tool = () => proposalOf(controlRequest(WRITE_REQUEST));
  const withAddRules = () =>
    proposalOf(
      controlRequest({ ...WRITE_REQUEST, permission_suggestions: [ADD_RULES_SUGGESTION] }),
    );
  const question = () =>
    proposalOf(
      controlRequest({
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        input: {
          questions: [
            {
              question: "Which database?",
              multiSelect: false,
              options: [{ label: "Postgres" }, { label: "SQLite" }],
            },
            {
              question: "Which regions?",
              multiSelect: true,
              options: [{ label: "eu" }, { label: "us" }],
            },
          ],
        },
        requires_user_interaction: true,
      }),
    );
  const plan = () =>
    proposalOf(
      controlRequest({
        subtype: "can_use_tool",
        tool_name: "ExitPlanMode",
        input: { plan: "1. Write probe.txt" },
        requires_user_interaction: true,
      }),
    );

  test("allow passes the input through unchanged", () => {
    const applied = applySessionApprovalDecision(tool(), { choiceId: "allow" });
    expect(applied).toEqual({
      ok: true,
      reply: { behavior: "allow", updatedInput: WRITE_REQUEST.input },
    });
  });

  test("a suggestion choice replays its native permission update", () => {
    const applied = applySessionApprovalDecision(withAddRules(), { choiceId: "suggestion-1" });
    expect(applied).toEqual({
      ok: true,
      reply: {
        behavior: "allow",
        updatedInput: WRITE_REQUEST.input,
        updatedPermissions: [ADD_RULES_SUGGESTION],
      },
    });
    const setMode = applySessionApprovalDecision(tool(), { choiceId: "suggestion-1" });
    expect(setMode).toEqual({
      ok: true,
      reply: {
        behavior: "allow",
        updatedInput: WRITE_REQUEST.input,
        updatedPermissions: [SET_MODE_SUGGESTION],
      },
    });
  });

  test("deny carries the message, with a literal default when none is given", () => {
    expect(applySessionApprovalDecision(tool(), { choiceId: "deny" })).toEqual({
      ok: true,
      reply: { behavior: "deny", message: "The user denied this action." },
    });
    expect(applySessionApprovalDecision(tool(), { choiceId: "deny", message: "not now" })).toEqual({
      ok: true,
      reply: { behavior: "deny", message: "not now" },
    });
    // An empty message is no message: the default stands.
    expect(applySessionApprovalDecision(tool(), { choiceId: "deny", message: "" })).toEqual({
      ok: true,
      reply: { behavior: "deny", message: "The user denied this action." },
    });
  });

  test("answer amends the input with joined answers; free text is allowed", () => {
    const questionInput = {
      questions: [
        {
          question: "Which database?",
          multiSelect: false,
          options: [{ label: "Postgres" }, { label: "SQLite" }],
        },
        {
          question: "Which regions?",
          multiSelect: true,
          options: [{ label: "eu" }, { label: "us" }],
        },
      ],
    };
    const applied = applySessionApprovalDecision(question(), {
      choiceId: "answer",
      answers: { "Which database?": "SQLite", "Which regions?": ["eu", "us"] },
    });
    expect(applied).toEqual({
      ok: true,
      reply: {
        behavior: "allow",
        updatedInput: {
          ...questionInput,
          answers: { "Which database?": "SQLite", "Which regions?": "eu, us" },
        },
      },
    });
    const free = applySessionApprovalDecision(question(), {
      choiceId: "answer",
      answers: { "Which database?": "a third thing" },
    });
    expect(free).toMatchObject({ ok: true, reply: { behavior: "allow" } });
  });

  test("decline denies with its own literal default message", () => {
    expect(applySessionApprovalDecision(question(), { choiceId: "decline" })).toEqual({
      ok: true,
      reply: { behavior: "deny", message: "The user declined to answer." },
    });
    expect(applySessionApprovalDecision(question(), { choiceId: "decline", message: "" })).toEqual({
      ok: true,
      reply: { behavior: "deny", message: "The user declined to answer." },
    });
  });

  test("approve passes the plan input through; deny carries feedback", () => {
    expect(applySessionApprovalDecision(plan(), { choiceId: "approve" })).toEqual({
      ok: true,
      reply: { behavior: "allow", updatedInput: { plan: "1. Write probe.txt" } },
    });
    expect(
      applySessionApprovalDecision(plan(), { choiceId: "deny", message: "add a test step" }),
    ).toEqual({ ok: true, reply: { behavior: "deny", message: "add a test step" } });
  });

  test("an unknown choice id is rejected without a reply", () => {
    for (const proposal of [tool(), question(), plan()]) {
      expect(applySessionApprovalDecision(proposal, { choiceId: "nope" })).toEqual({
        ok: false,
        reason: "unknown-choice",
      });
    }
  });

  test.each([
    ["message on allow", { choiceId: "allow", message: "hi" }, tool()],
    ["message on a suggestion", { choiceId: "suggestion-1", message: "hi" }, tool()],
    ["message on answer", { choiceId: "answer", message: "hi" }, question()],
    ["message on approve", { choiceId: "approve", message: "hi" }, plan()],
  ])(
    "a misplaced message is rejected invalid-message, so the host reads which field to fix: %s",
    (_label, decision, proposal) => {
      expect(applySessionApprovalDecision(proposal, decision as SessionApprovalDecision)).toEqual({
        ok: false,
        reason: "invalid-message",
      });
    },
  );

  test.each([
    ["answers on allow", { choiceId: "allow", answers: { q: "a" } }, tool()],
    ["answers on deny", { choiceId: "deny", answers: { q: "a" } }, tool()],
    ["answer with no answers", { choiceId: "answer" }, question()],
    ["answer with empty answers", { choiceId: "answer", answers: {} }, question()],
    [
      "answer naming an unasked question",
      { choiceId: "answer", answers: { nope: "a" } },
      question(),
    ],
    [
      "answer with an empty label",
      { choiceId: "answer", answers: { "Which database?": "" } },
      question(),
    ],
    [
      "answer with an empty label array",
      { choiceId: "answer", answers: { "Which database?": [] } },
      question(),
    ],
    [
      "answer with a non-string label in the array",
      { choiceId: "answer", answers: { "Which regions?": ["eu", 3] } },
      question(),
    ],
  ])("invalid answers are rejected invalid-answers: %s", (_label, decision, proposal) => {
    expect(applySessionApprovalDecision(proposal, decision as SessionApprovalDecision)).toEqual({
      ok: false,
      reason: "invalid-answers",
    });
  });
});

describe("issue #454: encoding the native reply", () => {
  test("the control_response envelope is exact", () => {
    const line = encodeClaudeControlResponse("req-1", {
      behavior: "deny",
      message: "no",
    });
    expect(JSON.parse(line)).toEqual({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "req-1",
        response: { behavior: "deny", message: "no" },
      },
    });
    expect(line.endsWith("\n")).toBe(true);
  });

  test("an allow reply carries updatedInput and, for a suggestion, updatedPermissions", () => {
    expect(
      JSON.parse(
        encodeClaudeControlResponse("req-2", {
          behavior: "allow",
          updatedInput: { a: 1 },
          updatedPermissions: [SET_MODE_SUGGESTION],
        }),
      ).response.response,
    ).toEqual({
      behavior: "allow",
      updatedInput: { a: 1 },
      updatedPermissions: [SET_MODE_SUGGESTION],
    });
    expect(
      JSON.parse(
        encodeClaudeControlResponse("req-3", { behavior: "allow", updatedInput: { a: 1 } }),
      ).response.response,
    ).toEqual({ behavior: "allow", updatedInput: { a: 1 } });
  });
});
