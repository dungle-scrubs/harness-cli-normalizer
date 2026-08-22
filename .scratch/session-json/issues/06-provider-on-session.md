# T06 - --provider on hcn session

Status: done
Blocked by: 02

## What to build

A program can run a pi session against a chosen provider, the way a one-shot
run already can. `--provider <value>` on the session command reaches the
spawned argv. On a harness that has no provider selector the flag is refused
with the same structured refusal a one-shot run gives, naming where the
option is supported. This is the local-provider lane a downstream consumer
needs.

## Acceptance criteria

- [ ] The session options and the session argv builder carry a provider.
- [ ] `--provider` on a pi session renders the provider on the spawned argv.
- [ ] `--provider` on a harness without a provider selector is refused with
      the structured refusal, naming the supported harness.
- [ ] Proven via argv preview or capability inspection: provider present on a
      pi session, refused on another harness.
