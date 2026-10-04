# Antigravity 1.2.16 verification, 2026-10-03

All seven native tripwires and the question tripwire passed. Current stdout
captures replay through the current decoder for identity, streaming, tool use,
persistent turns, resume, interruption recovery and escalation. The independent
public models.txt contains 14 distinct slugs; tests compare them with the full
descriptor roster and pin version.txt to1.2.16.

Seven synthetic 20000-word blocks reproduced automatic checkpointing on
gemini-3.8-flash-medium. All nine turns completed cleanly. A retained native
CHECKPOINT contains LANTERN-903, and a separate process recalled that marker.
Both saved HCN output and captured native later-recall stdout are retained.
Current decodeLine verifies the native identity, exact answer and absence of
errors. The recall prompt itself contains no marker.

GPT-OSS also produced a checkpoint but then failed with native capacity503,
exit3. That outcome remains a decoded terminal error with no successful
message. Native print-mode /context refusal remains a failure. No full-capacity,
lossless recall or pending-prompt accounting guarantee is inferred.
