# Roadmap

Planned work for hcn. Each item must pass the scope test in `AGENTS.md`.

## New harnesses

- **Junie CLI** - qualify a pinned stable release, then add a descriptor and
  support in the interpretation and execution layers. Verify headless streaming,
  approvals, cancellation, usage, and resume behavior. Blocked on an authenticated
  qualification because no Junie account or API key is available. Public and
  unauthenticated probes confirm the CLI shape but not execution behavior. See the
  [candidate research](docs/research/2026-09-19-junie-pricing-and-harness-fit.md).
- **Grok Build CLI** - add a descriptor and support in the interpretation and
  execution layers. Blocked: no Grok subscription to capture authenticated runs.

## Shipped harnesses

- **Antigravity CLI 1.2.7** - authenticated qualification covers headless
  streaming, native permissions, cancellation, timeout, model selection,
  persistent sessions, named resume, resume last, native store creation,
  native transcript reads, and structured failures. Quota exhaustion remains
  uncaptured. See the
  [assessment](docs/research/2026-09-19-antigravity-cli-harness-assessment.md).

## Provider configurations

- **OpenCode Go through Pi** - verify and document the subscription as a Pi
  provider configuration used through hcn. Check Go's dedicated endpoints,
  model selection, session headers, and subscription usage accounting with a
  harmless authenticated run. Keep billing credentials in the native provider
  configuration.
- **Ollama through Pi** - verify and document the cloud subscription as a Pi
  provider configuration used through hcn. Check authentication, cloud model
  selection, tool use, and subscription usage accounting with a harmless
  authenticated run. Keep billing credentials in the native provider
  configuration.
