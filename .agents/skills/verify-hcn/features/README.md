# hcn verification map

Baseline: build the checkout, use disposable fixture roots, capture command/revision/output/exit status in the main checkout's task folder. Built-CLI tests replace the native harness executable; internal tests provide supplementary coverage and may inject other dependencies. Never substitute real HOME or credentials. Read each relevant feature and cover its entry points; a skipped path remains unverified.

- [Run observations](run-observations.md): native tool results, usage and terminal outcomes.
- [Access presets](access-presets.md): fresh, named-resume and resume-last access rendering.
- [Resume and failures](resume-and-failures.md): resume guards, warnings, provider errors and process exits.
