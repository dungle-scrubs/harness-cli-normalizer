# The NDJSON protocol's types ship at ./protocol

Status: accepted 2026-11-15. Issue
[#441](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/441)
proposed types plus a typed client; the maintainer ruled on the scope in the
request: types only, and the CLI keeps writing the wire itself.

## The decision

The package exports the TypeScript types of hcn's two machine streams at the
subpath `./protocol`:

- `RunEvent`: every line `hcn run --json` writes on stdout.
- `SessionEvent`: every line `hcn session --json` writes on stdout.
- `SessionCommand`: every stdin command `hcn session --json` reads.

The NDJSON protocol stays the contract. A TypeScript consumer imports the
types and parses the lines itself, so non-TypeScript consumers are unchanged
and nothing about the wire changes. The types describe the wire format of
the hcn version they were installed with, so shape drift fails the
consumer's typecheck instead of surfacing at runtime.

Three boundaries hold:

- **No client.** The package exports no code that spawns hcn, writes
  commands, or reads events. A consumer that wants that still owns the
  process, the way graybox's phase runner does today.
- **No in-process library.** `openSession` and `streamTurn` stay internal.
  Exporting them would load hcn's harness SDKs into the consumer's process
  and couple their dependency versions; the process boundary is what keeps
  harness dependencies and failures out of the consumer.
- **Nothing else.** No root export, no `main`, no deep `dist` paths. The
  `hcn` binary is still the product; `scripts/check-package.ts` deep-checks
  the export map so the surface cannot grow by accident.

## Why the types are these types

`src/cli/protocol.ts` re-exports `HarnessEvent`, `FailureSummary` and the
field types from the modules that own them, and the CLI writes the streams
through the unions it publishes: `runJsonSession`'s `emit` takes
`SessionEvent`, the refusal, crash and transport-failure paths write
`TerminalDoneEvent` values, and the render helpers type their parameters as
`RunEvent | SessionEvent`. The export is the writer's own type, not a copy,
so adding a field or an event kind fails `pnpm typecheck` until
`protocol.ts` agrees - in hcn and in every consumer.

The consumer gate (`test/protocol/consumer.test.ts`) compiles a temporary
project with no `@types/node` and no dependencies against the built `dist/`,
so every declaration the export reaches stays checkable outside this
repository, and it pins the surface to `./protocol` by resolving the package
root and a deep path only as errors.

## The one-way door

The exported types are a public API. Once consumers depend on them, removing
a name or narrowing a union breaks their builds the way a wire change breaks
their parsers, and releases are semantic-version bound to treat that as
breaking. Additive growth (a new optional field, a new kind) follows the
existing protocol rule that a consumer ignores what it does not recognize;
the unions say so by construction, because the wire emits what they name.
