import { describe, expect, test } from "vitest";
import {
  type ContentEvent,
  contentEventsOf,
  contentEventsWithState,
  freshReaderState,
  type ReaderState,
} from "../../src/interpretation/content.js";

/**
 * Background jobs and subagent steps on claude's stream-json, spec
 * sections 1 and 2. Every record below is real, quoted from the
 * 2026-11-09 capture of claude 2.1.319 in
 * ~/dev/dotfiles/.scratch/herdr-harness-controls/evidence/claude-background-events-2026-11-09.ndjson
 * (a `run_in_background` Bash loop, task bcrfa3pxt, and a background
 * Agent, task a34310bd3dc4bd051). Synthetic records appear only where
 * the spec decides a skip no captured line exercised, and say so.
 */

const shellStarted = {
  type: "system",
  subtype: "task_started",
  task_id: "bcrfa3pxt",
  run_id: "0mw8uobqx-def2eb6d",
  tool_use_id: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
  description: "Run background tick loop",
  is_backgrounded: true,
  task_type: "local_bash",
  uuid: "f8158f2f-29f1-4565-b28e-f12c7c5394ea",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const agentStarted = {
  type: "system",
  subtype: "task_started",
  task_id: "a34310bd3dc4bd051",
  run_id: "0mw8uoebg-321de148",
  tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  description: "Count files",
  subagent_type: "general-purpose",
  is_backgrounded: true,
  spawn_depth: 1,
  task_type: "local_agent",
  prompt: "Run ls / | wc -l and report the number.",
  uuid: "681862fb-e292-4782-8f83-13f31d0f5855",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const agentProgress = {
  type: "system",
  subtype: "task_progress",
  task_id: "a34310bd3dc4bd051",
  run_id: "0mw8uoebg-321de148",
  tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  description: "Running Count entries in root directory",
  subagent_type: "general-purpose",
  usage: { total_tokens: 27921, tool_uses: 1, duration_ms: 2100 },
  last_tool_name: "Bash",
  uuid: "0986a776-135c-4a50-89b2-8a457237325a",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const agentUpdatedCompleted = {
  type: "system",
  subtype: "task_updated",
  task_id: "a34310bd3dc4bd051",
  run_id: "0mw8uoebg-321de148",
  patch: { status: "completed", end_time: 1794203904772 },
  uuid: "78813ec5-395a-42be-8eca-fe5e49cf6535",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const shellUpdatedCompleted = {
  type: "system",
  subtype: "task_updated",
  task_id: "bcrfa3pxt",
  run_id: "0mw8uobqx-def2eb6d",
  patch: { status: "completed", end_time: 1794203909753 },
  uuid: "134a053b-1382-4c7f-8da7-e99835901111",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const agentNotification = {
  type: "system",
  subtype: "task_notification",
  task_id: "a34310bd3dc4bd051",
  run_id: "0mw8uoebg-321de148",
  tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  status: "completed",
  output_file:
    "/private/tmp/claude-501/-private-tmp-claude-501--Users-kevin-dev-dotfiles-978d1578-5554-4735-80a1-2bfadd959edd-scratchpad-bgprobe/c81a836f-e08d-4fe1-ae5c-b6988292d264/tasks/a34310bd3dc4bd051.output",
  summary: "`ls / | wc -l` printed **17**, so the root directory has 17 entries.",
  usage: { total_tokens: 30933, tool_uses: 1, duration_ms: 3723 },
  uuid: "1681ea64-4e86-452b-9cda-0c9d36553648",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const shellNotification = {
  type: "system",
  subtype: "task_notification",
  task_id: "bcrfa3pxt",
  run_id: "0mw8uobqx-def2eb6d",
  tool_use_id: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
  status: "completed",
  output_file:
    "/private/tmp/claude-501/-private-tmp-claude-501--Users-kevin-dev-dotfiles-978d1578-5554-4735-80a1-2bfadd959edd-scratchpad-bgprobe/c81a836f-e08d-4fe1-ae5c-b6988292d264/tasks/bcrfa3pxt.output",
  summary: 'Background command "Run background tick loop" completed (exit code 0)',
  uuid: "ce29c49d-a96f-453c-ab5e-85ad009ac556",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

const tasksChanged = {
  type: "system",
  subtype: "background_tasks_changed",
  tasks: [
    {
      task_id: "bcrfa3pxt",
      run_id: "0mw8uobqx-def2eb6d",
      task_type: "local_bash",
      description: "Run background tick loop",
    },
  ],
  uuid: "4b0194cb-279b-4769-b7e5-a650fc25247e",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
};

/** The subagent's own Bash call, a real assistant line carrying
 * `parent_tool_use_id` (the Agent call toolu_012jE8yMKUqo4bjJcHR7ZVkL). */
const subagentBashCall = {
  type: "assistant",
  message: {
    model: "claude-sonnet-5-5",
    id: "msg_011Cgrqko2X3f77i8niW4hEQ",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_01MUEttnZ12CienaciPXJPmq",
        name: "Bash",
        input: { command: "ls / | wc -l", description: "Count entries in root directory" },
        caller: { type: "direct" },
      },
    ],
  },
  parent_tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  agent_id: "a34310bd3dc4bd051",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
  uuid: "00fd85ae-549c-4b76-8386-e2542ffbd5a0",
  timestamp: "2026-11-09T05:58:23.147Z",
  request_id: "req_011Cgrqknq7fQxEhx9eJAbLc",
  subagent_type: "general-purpose",
  task_description: "Count files",
};

const subagentBashResult = {
  type: "user",
  message: {
    role: "user",
    content: [
      {
        tool_use_id: "toolu_01MUEttnZ12CienaciPXJPmq",
        type: "tool_result",
        content: "      17",
        is_error: false,
      },
    ],
  },
  parent_tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  agent_id: "a34310bd3dc4bd051",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
  uuid: "58c2e27e-d5af-4a19-9295-67a65cde9a2f",
  timestamp: "2026-11-09T05:58:23.517Z",
  subagent_type: "general-purpose",
  task_description: "Count files",
};

const subagentAnswer = {
  type: "assistant",
  message: {
    model: "claude-sonnet-5-5",
    id: "msg_011CgrqkyFBEhkEJwCJyYiSV",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "text",
        text: "`ls / | wc -l` printed **17**, so the root directory has 17 entries.",
      },
    ],
  },
  parent_tool_use_id: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
  agent_id: "a34310bd3dc4bd051",
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
  uuid: "2fd7537c-5887-4007-948c-1146dbba6ce5",
  timestamp: "2026-11-09T05:58:24.725Z",
  subagent_type: "general-purpose",
  task_description: "Count files",
};

/** A main-loop assistant line: `parent_tool_use_id` null, no parentCallId. */
const mainLoopAnswer = {
  type: "assistant",
  message: {
    model: "claude-sonnet-5-5",
    id: "msg_011CgrqkoBhVtH7aPhpHQV3k",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "started" }],
  },
  parent_tool_use_id: null,
  session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
  uuid: "802743cd-5fb2-4a81-88cb-670d31cd7e8f",
  timestamp: "2026-11-09T05:58:22.079Z",
};

/** Thread the reader state the way the decode pumps do, so a job's own
 * start can teach the registry its later lines read. */
const decodeAll = (records: readonly unknown[]): ContentEvent[] => {
  let state: ReaderState = freshReaderState("claude");
  const events: ContentEvent[] = [];
  for (const record of records) {
    const step = contentEventsWithState("claude", record, state);
    state = step.state;
    events.push(...step.events);
  }
  return events;
};

const backgroundOf = (events: ContentEvent[]) => events.filter((e) => e.kind === "background");

describe("claude background jobs: the mapping rows", () => {
  test("task_started of a background Bash loop is a running shell job", () => {
    expect(decodeAll([shellStarted])).toEqual([
      {
        kind: "background",
        id: "bcrfa3pxt",
        job: "shell",
        state: "running",
        description: "Run background tick loop",
        backgrounded: true,
        callId: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
      },
    ]);
  });

  test("task_started of a background Agent is a running agent job with its type", () => {
    expect(decodeAll([agentStarted])).toEqual([
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "running",
        description: "Count files",
        backgrounded: true,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
        agent: "general-purpose",
      },
    ]);
  });

  test("task_progress reports the step, its usage and the job last seen", () => {
    expect(decodeAll([agentStarted, agentProgress]).slice(1)).toEqual([
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "running",
        detail: "Running Count entries in root directory",
        toolUses: 1,
        totalTokens: 27921,
        durationMs: 2100,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
        agent: "general-purpose",
      },
    ]);
  });

  test("task_updated with a status patch reports the state and nothing else", () => {
    expect(decodeAll([agentStarted, agentUpdatedCompleted]).slice(1)).toEqual([
      { kind: "background", id: "a34310bd3dc4bd051", job: "agent", state: "completed" },
    ]);
    expect(decodeAll([shellStarted, shellUpdatedCompleted]).slice(1)).toEqual([
      { kind: "background", id: "bcrfa3pxt", job: "shell", state: "completed" },
    ]);
  });

  test("task_notification carries the output file, the summary and the call id", () => {
    expect(decodeAll([agentStarted, agentNotification]).slice(1)).toEqual([
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "completed",
        outputFile: agentNotification.output_file,
        summary: agentNotification.summary,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
    ]);
    expect(decodeAll([shellStarted, shellNotification]).slice(1)).toEqual([
      {
        kind: "background",
        id: "bcrfa3pxt",
        job: "shell",
        state: "completed",
        outputFile: shellNotification.output_file,
        summary: shellNotification.summary,
        callId: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
      },
    ]);
  });

  test("one job's full crossing, in capture order", () => {
    expect(
      backgroundOf(
        decodeAll([
          tasksChanged,
          agentStarted,
          agentProgress,
          subagentBashCall,
          subagentBashResult,
          subagentAnswer,
          agentUpdatedCompleted,
          agentNotification,
        ]),
      ),
    ).toEqual([
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "running",
        description: "Count files",
        backgrounded: true,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
        agent: "general-purpose",
      },
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "running",
        detail: "Running Count entries in root directory",
        toolUses: 1,
        totalTokens: 27921,
        durationMs: 2100,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
        agent: "general-purpose",
      },
      { kind: "background", id: "a34310bd3dc4bd051", job: "agent", state: "completed" },
      {
        kind: "background",
        id: "a34310bd3dc4bd051",
        job: "agent",
        state: "completed",
        outputFile: agentNotification.output_file,
        summary: agentNotification.summary,
        callId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
    ]);
  });

  test("the end statuses the spec maps: killed, stopped and cancelled all read stopped", () => {
    // The capture held only `completed`; these are the spec's mapping, so
    // the records are synthetic patch/notification shapes on a real id.
    for (const status of ["killed", "stopped", "cancelled"]) {
      expect(
        backgroundOf(
          decodeAll([
            shellStarted,
            { ...shellUpdatedCompleted, patch: { status, end_time: 1794203909753 } },
          ]),
        ).at(-1),
      ).toEqual({ kind: "background", id: "bcrfa3pxt", job: "shell", state: "stopped" });
    }
    expect(
      backgroundOf(decodeAll([shellStarted, { ...shellNotification, status: "failed" }])).at(-1),
    ).toEqual(
      expect.objectContaining({
        kind: "background",
        id: "bcrfa3pxt",
        job: "shell",
        state: "failed",
      }),
    );
    expect(
      backgroundOf(
        decodeAll([shellStarted, { ...shellUpdatedCompleted, patch: { status: "running" } }]),
      ).at(-1),
    ).toEqual({ kind: "background", id: "bcrfa3pxt", job: "shell", state: "running" });
  });

  test("task_started forwards backgrounded false from the explicit inline capture", () => {
    // Whole task_started record from claude-inline-agent-native-explicit-2026-11-09.ndjson.
    const captured = {
      type: "system",
      subtype: "task_started",
      task_id: "a1d655a05edd41743",
      run_id: "0mw9359p9-f950a6a1",
      tool_use_id: "toolu_016VFgZWiCk7BLrb9wQDaza3",
      description: "Read note",
      subagent_type: "general-purpose",
      is_backgrounded: false,
      spawn_depth: 1,
      task_type: "local_agent",
      prompt: "Read note.txt and report its contents.",
      uuid: "639e926c-fe1c-49b8-b9be-32515ce453b3",
      session_id: "a71aabd0-db58-41d9-92c8-5cab510ecd77",
    };
    expect(decodeAll([captured])).toEqual([
      {
        kind: "background",
        id: captured.task_id,
        job: "agent",
        state: "running",
        backgrounded: false,
        description: captured.description,
        callId: captured.tool_use_id,
        agent: captured.subagent_type,
      },
    ]);
  });

  test("task_started forwards backgrounded true from the omitted-mode capture", () => {
    // Whole task_started record from claude-inline-agent-native-2026-11-09.ndjson.
    const captured = {
      type: "system",
      subtype: "task_started",
      task_id: "a309af50885b79194",
      run_id: "0mw934nqy-2f89a3af",
      tool_use_id: "toolu_01RNH3WANJxtbvdmQ7wERa84",
      description: "Read note.txt and report contents",
      subagent_type: "general-purpose",
      is_backgrounded: true,
      spawn_depth: 1,
      task_type: "local_agent",
      prompt:
        "Read the file note.txt and report its full contents back verbatim. Look first at /private/tmp/claude-501/-Users-kevin-dev-dotfiles/978d1578-5554-4735-80a1-2bfadd959edd/scratchpad/inline-probe.IMmI/note.txt. If it is not there, search that directory tree for a file named note.txt. Do not modify, create, or delete any file. Your final reply should contain only the file's contents, or a clear statement that no note.txt was found.",
      uuid: "68d62d8b-7d1d-415e-a019-9b1a436cd42a",
      session_id: "f6b4c60b-5023-4a37-b6c8-3da39e699b9a",
    };
    expect(decodeAll([captured])).toEqual([
      {
        kind: "background",
        id: captured.task_id,
        job: "agent",
        state: "running",
        backgrounded: true,
        description: captured.description,
        callId: captured.tool_use_id,
        agent: captured.subagent_type,
      },
    ]);
  });

  test("backgrounded is omitted unless the native record carries a boolean", () => {
    const { is_backgrounded: _dropped, ...withoutFlag } = shellStarted;
    for (const record of [withoutFlag, { ...shellStarted, is_backgrounded: "true" }]) {
      const events = decodeAll([record]);
      expect(events).toHaveLength(1);
      expect(events[0]).not.toHaveProperty("backgrounded");
    }
  });

  test("later task records forward their own boolean without carrying a previous flag", () => {
    for (const record of [agentProgress, agentUpdatedCompleted, agentNotification]) {
      const later = decodeAll([agentStarted, { ...record, is_backgrounded: false }]).slice(1);
      expect(later).toHaveLength(1);
      expect(later[0]).toHaveProperty("backgrounded", false);
      expect(decodeAll([agentStarted, record])[1]).not.toHaveProperty("backgrounded");
    }
  });

  test("a task_type on a later line still names the job", () => {
    expect(decodeAll([{ ...agentProgress, task_type: "local_agent" }])).toEqual([
      expect.objectContaining({ kind: "background", id: "a34310bd3dc4bd051", job: "agent" }),
    ]);
  });
});

describe("claude background jobs: the skips", () => {
  test("background_tasks_changed emits nothing, not even progress", () => {
    expect(decodeAll([tasksChanged])).toEqual([]);
    expect(decodeAll([{ type: "system", subtype: "background_tasks_changed", tasks: [] }])).toEqual(
      [],
    );
  });

  test("task_summary emits nothing (synthetic; the binary has it, the capture does not)", () => {
    expect(decodeAll([{ type: "system", subtype: "task_summary" }])).toEqual([]);
  });

  test("a task_type outside the two emits nothing and records nothing", () => {
    expect(decodeAll([{ ...shellStarted, task_type: "local_mcp" }])).toEqual([]);
    // The job was never seen, so its later lines without a task_type are
    // unknown too.
    expect(decodeAll([{ ...shellStarted, task_type: "local_mcp" }, shellNotification])).toEqual([]);
  });

  test("a line without a task_id emits nothing", () => {
    const { task_id: _dropped, ...withoutId } = shellStarted;
    expect(decodeAll([withoutId])).toEqual([]);
  });

  test("a later line for an id whose job was never seen emits nothing", () => {
    expect(decodeAll([agentProgress])).toEqual([]);
    expect(decodeAll([agentUpdatedCompleted])).toEqual([]);
    expect(decodeAll([agentNotification])).toEqual([]);
  });

  test("a task_updated without a status patch, or with an unknown status, emits nothing", () => {
    expect(decodeAll([shellStarted, { ...shellUpdatedCompleted, patch: {} }]).slice(1)).toEqual([]);
    expect(
      decodeAll([shellStarted, { ...shellUpdatedCompleted, patch: { status: "pending" } }]).slice(
        1,
      ),
    ).toEqual([]);
    expect(
      decodeAll([
        shellStarted,
        { type: "system", subtype: "task_updated", task_id: "bcrfa3pxt" },
      ]).slice(1),
    ).toEqual([]);
  });

  test("a task_notification with an unknown status emits nothing", () => {
    expect(
      decodeAll([shellStarted, { ...shellNotification, status: "vanished" }]).slice(1),
    ).toEqual([]);
  });

  test("a job survives another job's lines: the registry keys by id", () => {
    const events = decodeAll([shellStarted, agentStarted, agentProgress, shellNotification]);
    expect(backgroundOf(events).map((e) => [e.id, e.job, e.state])).toEqual([
      ["bcrfa3pxt", "shell", "running"],
      ["a34310bd3dc4bd051", "agent", "running"],
      ["a34310bd3dc4bd051", "agent", "running"],
      ["bcrfa3pxt", "shell", "completed"],
    ]);
  });

  test("a notification retires only its own job, preserving another job's later records", () => {
    expect(
      backgroundOf(
        decodeAll([
          shellStarted,
          agentStarted,
          shellNotification,
          agentProgress,
          agentUpdatedCompleted,
        ]),
      ).map((event) => [event.id, event.job, event.state]),
    ).toEqual([
      ["bcrfa3pxt", "shell", "running"],
      ["a34310bd3dc4bd051", "agent", "running"],
      ["bcrfa3pxt", "shell", "completed"],
      ["a34310bd3dc4bd051", "agent", "running"],
      ["a34310bd3dc4bd051", "agent", "completed"],
    ]);
  });

  test("remembering an unchanged job preserves reader state, while a changed job replaces it", () => {
    const first = contentEventsWithState("claude", shellStarted, freshReaderState("claude"));
    const repeated = contentEventsWithState("claude", shellStarted, first.state);
    expect(repeated.state).toBe(first.state);
    const renamed = contentEventsWithState(
      "claude",
      { ...shellStarted, task_type: "local_agent" },
      repeated.state,
    );
    const notified = contentEventsWithState("claude", shellNotification, renamed.state);
    expect(notified.events).toEqual([
      expect.objectContaining({ kind: "background", id: shellStarted.task_id, job: "agent" }),
    ]);
  });

  test("a job is kept through its terminal task_updated and dropped at its task_notification", () => {
    // The update keeps the entry: the notification that follows, with
    // no task_type of its own, still finds the job.
    expect(
      backgroundOf(decodeAll([shellStarted, shellUpdatedCompleted, shellNotification])).map(
        (e) => e.state,
      ),
    ).toEqual(["running", "completed", "completed"]);
    // The notification retires the entry: a later line for the same id
    // with no task_type names an unknown job and emits nothing.
    expect(
      decodeAll([
        shellStarted,
        shellNotification,
        { type: "system", subtype: "task_progress", task_id: "bcrfa3pxt" },
      ]),
    ).toHaveLength(2);
  });

  test("a long-running shell keeps its job through newer jobs and terminal updates", () => {
    // Jobs awaiting notifications remain registered even after terminal
    // updates, so newer jobs cannot displace this shell's job type.
    const records: unknown[] = [shellStarted];
    for (let index = 0; index < 100; index += 1) {
      const id = `newer-agent-${index}`;
      records.push({ ...agentStarted, task_id: id, description: `newer ${index}` });
      if (index % 2 === 0) {
        records.push({
          type: "system",
          subtype: "task_updated",
          task_id: id,
          patch: { status: "completed" },
        });
      }
    }
    records.push(shellUpdatedCompleted, shellNotification);
    expect(
      backgroundOf(decodeAll(records))
        .filter((e) => e.id === "bcrfa3pxt")
        .map((e) => e.state),
    ).toEqual(["running", "completed", "completed"]);
  });
});

describe("claude subagent lines carry parentCallId", () => {
  test("a non-null empty parent_tool_use_id adds no parentCallId", () => {
    const records = [subagentBashCall, subagentBashResult, subagentAnswer];
    const events = decodeAll(records.map((record) => ({ ...record, parent_tool_use_id: "" })));
    expect(events).toEqual(
      decodeAll(records).map((event) => {
        if (!("parentCallId" in event)) throw new Error("expected parentCallId");
        const { parentCallId: _parentCallId, ...mainLoopEvent } = event;
        return mainLoopEvent;
      }),
    );
    for (const event of events) expect(event).not.toHaveProperty("parentCallId");
  });

  test("the subagent's tool call, tool result and message all carry it", () => {
    const events = decodeAll([subagentBashCall, subagentBashResult, subagentAnswer]);
    expect(events).toEqual([
      {
        kind: "tool",
        name: "Bash",
        input: { command: "ls / | wc -l", description: "Count entries in root directory" },
        callId: "toolu_01MUEttnZ12CienaciPXJPmq",
        parentCallId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
      {
        kind: "tool-result",
        callId: "toolu_01MUEttnZ12CienaciPXJPmq",
        result: "      17",
        isError: false,
        parentCallId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
      {
        kind: "message",
        role: "assistant",
        text: "`ls / | wc -l` printed **17**, so the root directory has 17 entries.",
        parentCallId: "toolu_012jE8yMKUqo4bjJcHR7ZVkL",
      },
    ]);
  });

  test("a main-loop line carries no parentCallId", () => {
    const events = decodeAll([mainLoopAnswer]);
    expect(events).toEqual([{ kind: "message", role: "assistant", text: "started" }]);
  });

  test.each([null, undefined, ""])(
    "a main-loop parent %j attests its model on turn usage",
    (parent) => {
      const assistant = contentEventsWithState(
        "claude",
        { ...mainLoopAnswer, parent_tool_use_id: parent },
        freshReaderState("claude"),
      );
      const result = contentEventsWithState(
        "claude",
        { type: "result", usage: { input_tokens: 4, output_tokens: 376 } },
        assistant.state,
      );
      expect(result.events.filter((event) => event.kind === "usage")).toEqual([
        {
          kind: "usage",
          scope: "turn",
          inputTokens: 4,
          outputTokens: 376,
          inputIncludesCache: false,
          model: "claude-sonnet-5-5",
          models: ["claude-sonnet-5-5"],
        },
      ]);
    },
  );

  test("a subagent line does not enter the turn's main-loop model attestations", () => {
    // Asserted on the emission, not the reader's internals: a claude
    // result's turn usage reports the models the MAIN LOOP attested and
    // singles one out only when exactly one was. The result records are
    // synthetic minimal shapes (the decoder reads usage alone); the
    // assistant lines are the captured records above.
    const turnResult = {
      type: "result",
      subtype: "success",
      is_error: false,
      terminal_reason: "completed",
      session_id: "c81a836f-e08d-4fe1-ae5c-b6988292d264",
      usage: { input_tokens: 4, output_tokens: 376 },
    };
    const afterSubagent = contentEventsWithState(
      "claude",
      subagentAnswer,
      freshReaderState("claude"),
    );
    const subagentOnly = contentEventsWithState("claude", turnResult, afterSubagent.state);
    expect(subagentOnly.events.filter((e) => e.kind === "usage")).toEqual([
      {
        kind: "usage",
        scope: "turn",
        inputTokens: 4,
        outputTokens: 376,
        inputIncludesCache: false,
      },
    ]);
    const afterMainLoop = contentEventsWithState("claude", mainLoopAnswer, afterSubagent.state);
    const withMainLoop = contentEventsWithState("claude", turnResult, afterMainLoop.state);
    expect(withMainLoop.events.filter((e) => e.kind === "usage")).toEqual([
      {
        kind: "usage",
        scope: "turn",
        inputTokens: 4,
        outputTokens: 376,
        inputIncludesCache: false,
        model: "claude-sonnet-5-5",
        models: ["claude-sonnet-5-5"],
      },
    ]);
  });
});

describe("run-mode decoding reaches the background event statelessly", () => {
  test("contentEventsOf decodes a task_started without threaded state", () => {
    expect(contentEventsOf("claude", shellStarted)).toEqual([
      {
        kind: "background",
        id: "bcrfa3pxt",
        job: "shell",
        state: "running",
        description: "Run background tick loop",
        backgrounded: true,
        callId: "toolu_01HcjBC6KasyhZZTJUa1XN4p",
      },
    ]);
  });
});
