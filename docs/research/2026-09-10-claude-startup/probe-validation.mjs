// Synthetic protocol sequences, not captured harness fixtures.
import { createContextProbe } from "../../../src/interpretation/context-inspection.ts";
const id = "synthetic-probe";
const usage = {
  model: "claude-opus-5",
  totalTokens: 100,
  maxTokens: 1000,
  isAutoCompactEnabled: false,
};
const frame = (requestId, body, subtype = "success") =>
  JSON.stringify({
    type: "control_response",
    response: { request_id: requestId, response: body, subtype },
  });
function run(name, extra = [], response = usage, acknowledgement = id) {
  const probe = createContextProbe(id, "Synthetic pending request");
  const actions = [probe.accept(frame(`${id}:initialize`, {}))];
  actions.push(probe.accept(JSON.stringify({ type: "user", uuid: acknowledgement })));
  for (const event of extra) actions.push(probe.accept(JSON.stringify(event)));
  actions.push(probe.accept(frame(`${id}:usage`, response)));
  return { name, actions };
}
console.log(
  JSON.stringify(
    [
      run("valid-sequence"),
      run("wrong-replay-id", [], usage, "another-id"),
      run("missing-count-fields", [], { model: "claude-opus-5", maxTokens: 1000 }),
      run("unexpected-assistant-before-valid-usage", [
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Synthetic unexpected answer" }],
          },
        },
      ]),
    ],
    null,
    2,
  ),
);
