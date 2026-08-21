import { failureFromRejected } from "../execution/failure.js";
import type { ArgvRefusalError, RefusalIssue } from "../interpretation/refusal.js";
import { writeEventNdjson } from "./render.js";

export interface Refusal {
  readonly message: string;
  readonly issue: RefusalIssue;
  readonly option?: ArgvRefusalError["option"];
  readonly facet?: ArgvRefusalError["facet"];
  readonly supported?: readonly string[];
  readonly supportedBy?: ArgvRefusalError["supportedBy"];
  readonly hint?: string;
  readonly trailer?: readonly string[];
}

export const refusalOf = (err: ArgvRefusalError): Refusal => ({
  message: err.message,
  issue: err.issue,
  option: err.option,
  facet: err.facet,
  supported: err.supported,
  supportedBy: err.supportedBy,
  hint: err.hint,
});

export const refuse = (r: Refusal, json: boolean): void => {
  process.stderr.write(`${r.message}\n`);
  if (r.hint) process.stderr.write(`hint: ${r.hint}\n`);
  if (r.supportedBy?.length) {
    process.stderr.write(
      `supported on: ${r.supportedBy.map((e) => `${e.harness} (${e.spelling})`).join(", ")}\n`,
    );
  }
  if (r.supported?.length) process.stderr.write(`supported: ${r.supported.join(", ")}\n`);
  for (const line of r.trailer ?? []) process.stderr.write(`${line}\n`);
  if (json) {
    const summary = failureFromRejected({
      issue: r.issue,
      option: r.option,
      facet: r.facet,
      supported: r.supported,
      supportedBy: r.supportedBy,
      hint: r.hint,
      detail: r.message,
    });
    writeEventNdjson({ kind: "failure", ...summary });
    writeEventNdjson({ kind: "done", exitCode: null, cause: "failed", failure: summary });
  }
  process.exitCode = 2;
};
