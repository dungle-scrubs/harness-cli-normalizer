import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { nodeRunnerDeps } from "../execution/node-deps.js";
import { CLOSE_GRACE_MS, openSession } from "../execution/open-session.js";
import { ArgvRefusalError } from "../interpretation/refusal.js";
import type { HarnessDescriptor } from "../knowledge/descriptor.js";
import { defaultDescriptors } from "../knowledge/overrides.js";
import { createRenderState, renderEvent } from "./render.js";
import { resolveHarness } from "./resolve-harness.js";

export const session = async (harnessName: string, rawArgs: string[]): Promise<void> => {
  // issue #44: the gate is the descriptor's sessionMode (claude stream-json,
  // pi --mode rpc), not a hardcoded name list - a harness that grows a
  // session mode is available the moment its descriptor declares one.
  const h = resolveHarness(harnessName);
  if (h.sessionMode === null) {
    const supported = Object.values(defaultDescriptors())
      .filter((d): d is HarnessDescriptor => d !== undefined && d.sessionMode !== null)
      .map((d) => d.name);
    const err = new ArgvRefusalError({
      issue: "no-session-mode",
      harness: harnessName as "claude",
      supported,
      detail: `session mode is available on ${supported.join(", ")}; ${harnessName} declares no persistent headless session`,
    });
    process.stderr.write(`${err.message}\n`);
    process.stderr.write(`supported: ${supported.join(", ")}\n`);
    process.exitCode = 2;
    return;
  }

  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const { SESSION_HELP } = await import("./help.js");
    process.stdout.write(SESSION_HELP);
    return;
  }

  const { parseCommonFlags } = await import("./args.js");
  let parsed: ReturnType<typeof parseCommonFlags>;
  try {
    parsed = parseCommonFlags(rawArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`unknown flag: ${message}\n`);
    process.exitCode = 2;
    return;
  }

  const values = parsed.values as Record<string, unknown>;
  const sessionId =
    (values["session-id"] as string | undefined) ??
    (values.resume as string | undefined) ??
    randomUUID();
  const model = values.model as string | undefined;
  const cwd = values.cwd as string | undefined;
  const provider = values.provider as string | undefined;

  // issue #44: same precedence as hcn run - arg > project > user >
  // default-true. A behavior instruction, so it rides every send's
  // preamble, never a harness flag.
  const argEscalate =
    values["escalate-questions"] === true
      ? true
      : values["no-escalate-questions"] === true
        ? false
        : undefined;
  let escalateQuestions: boolean;
  let escalateTier: "arg" | "project-config" | "user-config" | "default";
  try {
    const { loadUserConfig, loadProjectConfig } = await import("./config.js");
    const user = loadUserConfig()?.config as { escalateQuestions?: boolean } | undefined;
    const project = loadProjectConfig()?.config as { escalateQuestions?: boolean } | undefined;
    escalateQuestions =
      argEscalate !== undefined
        ? argEscalate
        : project?.escalateQuestions !== undefined
          ? project.escalateQuestions
          : user?.escalateQuestions !== undefined
            ? user.escalateQuestions
            : true;
    escalateTier =
      argEscalate !== undefined
        ? "arg"
        : project?.escalateQuestions !== undefined
          ? "project-config"
          : user?.escalateQuestions !== undefined
            ? "user-config"
            : "default";
  } catch (configErr) {
    process.stderr.write(`config error: ${(configErr as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`provenance: escalateQuestions = ${escalateQuestions} (${escalateTier})\n`);

  // Validate sessionId shape? let openSession handle via assertUsableSessionId
  delete (process.env as Record<string, string | undefined>).HERDR_ENV;

  const wantJson = values.json === true;
  // Opt-in per-turn inactivity budget. 0 disables; no default. A session turn
  // can hang with the process alive, which no exit code reports.
  const rawStall = values.stall as string | undefined;
  let stallMs: number | undefined;
  if (rawStall !== undefined) {
    const seconds = Number(rawStall);
    if (!Number.isFinite(seconds) || seconds < 0) {
      process.stderr.write(`invalid --stall ${JSON.stringify(rawStall)}; expected seconds >= 0\n`);
      process.exitCode = 2;
      return;
    }
    if (seconds > 0) stallMs = seconds * 1000;
  }
  const baseDeps = stallMs === undefined ? nodeRunnerDeps() : nodeRunnerDeps({ stallMs });
  // Capture the runner's final exitCode/cause for the --json `closed` event.
  const closeInfo = { exitCode: null as number | null, cause: "clean" };
  const deps = wantJson
    ? {
        ...baseDeps,
        log: (e: Record<string, unknown>) => {
          if (e.event === "session_close") {
            closeInfo.exitCode = (e.exitCode as number | null) ?? null;
            closeInfo.cause = (e.cause as string) ?? "clean";
          }
          baseDeps.log?.(e);
        },
      }
    : baseDeps;

  let handle: ReturnType<typeof openSession>;
  try {
    handle = openSession(h, { sessionId, model, cwd, escalateQuestions, provider }, deps);
  } catch (err) {
    if (err instanceof ArgvRefusalError) {
      process.stderr.write(`${err.message}\n`);
      if (err.supported.length) process.stderr.write(`supported: ${err.supported.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `could not open session: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (wantJson) {
    const { runJsonSession } = await import("./session-json.js");
    const { getVersion } = await import("./version.js");
    process.exitCode = await runJsonSession({
      handle,
      sessionId,
      harness: h.name,
      hcnVersion: getVersion(),
      escalateQuestions,
      getCloseInfo: () => closeInfo,
    });
    return;
  }

  process.stdout.write(
    `interactive ${h.name} session ${sessionId}\n(empty line or "exit" to quit)\n`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // One line source for BOTH the you-prompt and the answer menu. A
  // readline interface buffers at most one pending line per question()
  // call site; the answer line typically arrives while the interface sits
  // BETWEEN calls (the turn is still streaming), and those bytes were
  // dropped (verified live: menu rendered, buffered "2" never delivered).
  // An explicit async-iterator pull never drops: the iterator parks on the
  // stream until the next line exists, whenever the caller asks for it.
  const lines = rl[Symbol.asyncIterator]();
  const nextLine = async (prompt: string): Promise<string | null> => {
    process.stdout.write(prompt);
    const res = await lines.next();
    return res.done ? null : (res.value as string);
  };

  // Handle SIGINT to close session cleanly
  let closing = false;
  let sendCount = 0;
  const doClose = async () => {
    if (closing) return;
    closing = true;
    try {
      // race with CLOSE_GRACE_MS ? openSession's close does escalation internally, but we add outer guard
      const timeout = setTimeout(() => {
        process.stderr.write(`close timed out after ${CLOSE_GRACE_MS}ms\n`);
      }, CLOSE_GRACE_MS + 1000);
      await handle.close();
      clearTimeout(timeout);
    } catch (err) {
      process.stderr.write(`close failed: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.close();
  };
  process.on("SIGINT", doClose);
  process.on("SIGTERM", doClose);

  const turns = handle.turns[Symbol.asyncIterator]();
  try {
    while (true) {
      let line: string | null;
      try {
        line = await nextLine("you › ");
      } catch {
        // stdin closed (Ctrl-D)
        break;
      }
      if (line === null) break;
      const trimmed = line.trim();
      if (trimmed === "" || trimmed === "exit") break;

      const result = handle.send({ id: `you-${++sendCount}`, text: line });
      if (result.disposition === "queued") {
        process.stderr.write(`disposition: queued (turn in progress)\n`);
      }

      const turn = (await turns.next()).value as
        | AsyncIterable<import("../execution/events.js").HarnessEvent>
        | undefined;
      if (turn === undefined) break;
      const state = createRenderState();
      // issue #44: a turn that ends awaiting-input renders its question as
      // a pickable menu; the choice (or a custom answer) is the next send,
      // delivered on the SAME live session - no exit, no resume.
      let asked:
        | (import("../execution/events.js").HarnessEvent & {
            kind: "question";
          })
        | null = null;
      for await (const event of turn) {
        renderEvent(event, state);
        if (event.kind === "question") asked = event;
      }
      if (asked !== null) {
        const q = asked;
        process.stdout.write(`\nanswer › pick a number, or type your own answer:\n`);
        for (let i = 0; i < q.options.length; i++) {
          const opt = q.options[i] as string;
          const mark = opt === q.recommended ? " (recommended)" : "";
          process.stdout.write(`  ${i + 1}. ${opt}${mark}\n`);
        }
        let answer: string | null = null;
        while (answer === null) {
          const a = ((await nextLine("> ")) ?? "").trim();
          if (a === "") continue;
          const n = Number(a);
          if (Number.isInteger(n) && n >= 1 && n <= q.options.length) {
            answer = q.options[n - 1] as string;
          } else {
            answer = a;
          }
        }
        handle.send({
          id: `you-${++sendCount}`,
          text: `The user answered the question: "${q.question}" with: ${answer}. Continue accordingly.`,
        });
        // Drain the answer turn BEFORE prompting again - the pump's
        // backpressure stalls the harness until the turn iterable is
        // consumed (verified live: menu answered, you-prompt rendered, no
        // answer turn ever ran).
        const answerTurn = (await turns.next()).value as
          | AsyncIterable<import("../execution/events.js").HarnessEvent>
          | undefined;
        if (answerTurn === undefined) break;
        const answerState = createRenderState();
        for await (const event of answerTurn) {
          renderEvent(event, answerState);
        }
      }
    }
  } catch (err) {
    process.stderr.write(`session error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", doClose);
    process.off("SIGTERM", doClose);
    try {
      await doClose();
    } catch {}
    rl.close();
  }
};
