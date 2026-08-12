# Session Input, Pump Settlement, and Main-Branch CI - Spike Report

## Result

A-001 passed under both supported runtime families. Destroying the adapter-owned stdout and stderr
readable streams releases async-iterator reads that remain pending after the direct child exits
while a descendant holds both pipes open.

| Runtime | Direct child exit | Before disposal | After disposal | Repeated disposal |
|---|---:|---|---|---|
| Node 24.15.0 | 7 | stdout and stderr pending | both rejected and settled | safe |
| Bun 1.3.14 with Node compatibility 24.3.0 | 7 | stdout and stderr pending | both fulfilled and settled | safe |

Both runtimes settled both reads inside the 1-second safety bound. The different fulfillment state
is expected adapter behavior and is not part of the execution contract. Production cleanup must
depend on pump settlement, normalize disposal-caused outcomes, and preserve unrelated pump errors.

## Evidence

The executable experiment is
[`artifacts/pipe-disposal-spike.mjs`](artifacts/pipe-disposal-spike.mjs). It uses exact descendant
process IDs for cleanup and does not use process-pattern termination.

Recorded output:

```json
{"directExit":{"code":7,"signal":null},"idempotentDestroy":true,"iteratorStateBeforeDestroy":"pending","iteratorStatesAfterDestroy":["rejected","rejected"],"node":"v24.15.0","runtime":"node","runtimeVersion":"24.15.0"}
{"directExit":{"code":7,"signal":null},"idempotentDestroy":true,"iteratorStateBeforeDestroy":"pending","iteratorStatesAfterDestroy":["fulfilled","fulfilled"],"node":"v24.3.0","runtime":"bun","runtimeVersion":"1.3.14"}
```

## Plan Consequence

<!-- D-008 --> Phase 2 will add `SpawnedProcess.disposeOutput()` as the shared, idempotent adapter
operation. The Node and Bun implementation will destroy both child-process readable streams, close
the shared `AsyncChannel`, and await both pumps before abandonment returns. No runtime-specific
abort interface is needed.

The implementation test must assert settlement rather than require rejection, because Node and Bun
settle a destroyed pending iterator differently.

## Reference Basis

- Node stream destruction releases stream resources:
  <https://nodejs.org/api/stream.html#readabledestroyerror>
- Child-process stdout and stderr are readable streams:
  <https://nodejs.org/api/child_process.html#subprocessstdout>
- Bun documents compatibility for `node:stream` and `node:child_process`:
  <https://bun.sh/docs/runtime/nodejs-compat>
