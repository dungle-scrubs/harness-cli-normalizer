// Synthetic count, not live capacity evidence. Exercises unchanged Lucid preparation.
import { createContextPreparer } from "/Users/kevin/dev/lucid/src/modes/context-preparation.ts";
let countCalls = 0;
const prepare = createContextPreparer({
  async countContext() {
    countCalls++;
    return {
      status: "available",
      executable: { path: "/synthetic/claude" },
      method: "native-context-estimate",
      model: "claude-opus-5",
      totalTokens: 970000,
      inputLimitTokens: 967000,
    };
  },
});
try {
  const result = await prepare({
    context: {
      from: 20,
      through: 20,
      history: [],
      mandatory: [],
      pending: {
        id: "input:probe",
        role: "user",
        kind: "message",
        seq: 20,
        text: "Continue.",
        provenance: {},
      },
      digest: "synthetic",
    },
    render: (context) => context.pending.text,
    route: {
      harness: "claude",
      model: "claude-opus-5",
      profile: "headless-turn",
      resume: "synthetic-native-session",
    },
  });
  console.log(JSON.stringify({ kind: "ready", countCalls, result }));
} catch (error) {
  console.log(
    JSON.stringify({
      kind: "held",
      countCalls,
      errorName: error.constructor.name,
      message: error.message,
    }),
  );
}
