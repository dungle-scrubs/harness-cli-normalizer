/**
 * The escalation probe (issue #84, RFC-01 Design section 4), as a library:
 * give a harness a task with a genuine unresolvable choice and check that
 * the turn ends on a `question` event with `done.cause = awaiting-input`.
 *
 * A pass carries an `observedOn` record shaped for `escalation.observedOn`
 * in the descriptor, so `capabilitiesOf` can compare its version against
 * `verifiedAgainst` to derive staleness.
 *
 * Consumers: smoke-questions (all harnesses, matrix + file) and
 * check-harnesses (drifted harnesses, per-claim report).
 */
import type { HarnessEvent } from "../../src/execution/events.js";
import { nodeRunnerDeps } from "../../src/execution/node-deps.js";
import { streamTurn } from "../../src/execution/stream-turn.js";
import type { HarnessDescriptor } from "../../src/knowledge/descriptor.js";
import { collect, modelFor } from "./seven-scenarios.js";

export interface Provenance {
  harness: string;
  model: string;
  version: string;
  date: string;
}

export interface ProbeCell {
  status: "pass" | "fail" | "skip";
  observedOn?: Provenance;
  detail: string;
}

const genuineDecisionTask =
  "you must write a file named deploy-target.txt into the current directory containing the environment this project deploys to. Two requirements are mutually exclusive and nothing in this directory says which applies: (a) the file must name the staging environment, or (b) it must name the production environment. The choice changes the file's contents and is not recoverable later without redoing the work. Decide whether to ask.";

export const probeAsk = async (h: HarnessDescriptor, version: string): Promise<ProbeCell> => {
  const model = modelFor(h) ?? "";
  const events = await collect(
    streamTurn(
      h,
      {
        prompt: genuineDecisionTask,
        cwd: process.cwd(),
        ...(model ? { model } : {}),
      },
      nodeRunnerDeps(),
    ),
  );
  const question = events.find((e) => e.kind === "question");
  const done = events.find((e) => e.kind === "done");
  if (!question) {
    const text = events
      .filter((e): e is Extract<HarnessEvent, { kind: "message" }> => e.kind === "message")
      .map((e) => e.text)
      .join("")
      .slice(0, 120);
    return {
      status: "fail",
      detail: `no question event (done=${done?.kind === "done" ? done.cause : "none"}): ${text}`,
    };
  }
  if (done?.kind !== "done" || done.cause !== "awaiting-input") {
    return {
      status: "fail",
      detail: `question present but done.cause=${done?.kind === "done" ? done.cause : "none"}`,
    };
  }
  const observedOn: Provenance = {
    harness: h.name,
    model,
    version,
    date: new Date().toISOString().slice(0, 10),
  };
  return { status: "pass", observedOn, detail: `question "${question.question.slice(0, 30)}"` };
};
