# Native failure is not an hcn failure

A harness that fails on its own arguments produces a distinct `native` FailureClass with the harness's own stderr verbatim and its exit code carried as `nativeExitCode` data. hcn's own exit code for this case is 1, never the harness's. The native message is labeled `NATIVE ERROR` so it cannot be confused with an hcn refusal (exit 2).

