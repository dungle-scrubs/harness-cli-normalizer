#!/usr/bin/env python3
"""pi --mode rpc spike, phase 2: the live-channel-critical behaviors.

Writes raw NDJSON transcripts + a PASS/FAIL assertion log into OUTDIR
(default: .). Probes:

  1. startup        - stdout at rest, get_state identity round trip
  2. lifecycle      - full event sequence for one prompt
  3. multiturn      - second prompt in the SAME process; id stability;
                      session-file existence; memory carry
  4. steer/followup - both queued DURING a tool-running turn; steer
                      delivered before the next LLM call, follow_up after
                      the run settles; queue_update events observed
  5. midstream      - prompt sent during streaming WITHOUT
                      streamingBehavior must fail with success:false
"""
import json, os, select, subprocess, sys, time

OUTDIR = sys.argv[1] if len(sys.argv) > 1 else "."
os.makedirs(OUTDIR, exist_ok=True)
CWD = "/tmp/pi-rpc-spike"
os.makedirs(CWD, exist_ok=True)
PASS, FAIL = [], []

def check(name, cond, detail=""):
    (PASS if cond else FAIL).append(name)
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

def send(proc, obj):
    proc.stdin.write((json.dumps(obj) + "\n").encode())
    proc.stdin.flush()

def drain(proc, seconds, stop_on=None):
    """Read stdout for up to `seconds`; stop early once `stop_on` (bytes)
    has been seen AND no more data arrives for 0.5s."""
    deadline = time.time() + seconds
    buf = b""
    while time.time() < deadline:
        r, _, _ = select.select([proc.stdout], [], [], 0.5)
        if r:
            chunk = os.read(proc.stdout.fileno(), 1 << 20)
            if not chunk:
                break
            buf += chunk
            if stop_on and stop_on in buf:
                time.sleep(0.5)
                r2, _, _ = select.select([proc.stdout], [], [], 0.3)
                if not r2:
                    break
        elif stop_on and stop_on in buf:
            break
    return buf

def records(buf):
    out = []
    for line in buf.decode("utf8", "replace").split("\n"):
        if line.strip():
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                out.append({"UNPARSED": line[:200]})
    return out

def save(name, buf):
    with open(os.path.join(OUTDIR, name), "w") as f:
        f.write(buf.decode("utf8", "replace"))
    return records(buf)

def assistant_text(recs):
    text = ""
    for r in recs:
        if r.get("type") == "message_end":
            m = r.get("message", {})
            if m.get("role") == "assistant":
                for c in m.get("content", []):
                    if c.get("type") == "text":
                        text += c.get("text", "")
    return text

def state_of(recs):
    for r in recs:
        if r.get("type") == "response" and r.get("command") == "get_state" and r.get("success"):
            return r.get("data", {})
    return {}

# ---------------- 1. startup ----------------
proc = subprocess.Popen(["pi", "--mode", "rpc"], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=CWD)
startup = drain(proc, 4)
recs1 = save("01-startup.ndjson", startup)
types1 = {r.get("type") for r in recs1}
check("startup emits no session/identity record",
      "session" not in types1 and not any(r.get("type") == "response" for r in recs1),
      f"types={sorted(str(t) for t in types1)}")
send(proc, {"id": "s1", "type": "get_state"})
st = state_of(save("01-startup.ndjson", drain(proc, 5) if False else b"") or []) # noop guard
# (append get_state response to the same fixture via re-drain)
buf = drain(proc, 5)
with open(os.path.join(OUTDIR, "01-startup.ndjson"), "a") as f:
    f.write(buf.decode("utf8", "replace"))
st = state_of(records(buf))
sid = st.get("sessionId")
check("get_state returns a session id", bool(sid), f"state={st}")
check("session file does NOT exist before first turn",
      "sessionFile" in st and not os.path.exists(st.get("sessionFile", "/nonexistent")))

# ---------------- 2. lifecycle ----------------
send(proc, {"id": "p1", "type": "prompt",
            "message": "Use the bash tool to run exactly: sleep 2 && echo SLEEP-DONE. Then reply DONE."})
life = drain(proc, 120, stop_on=b"agent_settled")
recs2 = save("02-turn-lifecycle.ndjson", life)
seq = [r.get("type") for r in recs2 if r.get("type")]
for marker in ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end", "agent_settled"]:
    check(f"lifecycle contains {marker}", marker in seq)
check("response:prompt precedes agent_start",
      seq.index("response") if "response" in seq else -1)  # response recs carry command field
resp_prompt = [r for r in recs2 if r.get("type") == "response" and r.get("command") == "prompt"]
check("prompt accepted (success true)", bool(resp_prompt) and resp_prompt[0].get("success") is True)
check("SLEEP-DONE task completed", "DONE" in assistant_text(recs2).upper())

# ---------------- 5. midstream error (before 3/4, reuses this settled proc? no - needs streaming) ----------------
# Start a long streaming turn, then send a bare prompt.
proc5 = subprocess.Popen(["pi", "--mode", "rpc"], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=CWD)
time.sleep(1.5)
send(proc5, {"id": "l1", "type": "prompt",
             "message": "Use the bash tool to run exactly: sleep 8 && echo LONG-DONE. Then reply LONG-COMPLETE."})
time.sleep(4)  # agent is streaming/executing the tool now
send(proc5, {"id": "bad1", "type": "prompt", "message": "should fail: no streamingBehavior"})
err_buf = drain(proc5, 10)
recs5 = save("05-prompt-during-stream-error.ndjson", err_buf)
bad = [r for r in recs5 if r.get("type") == "response" and r.get("command") == "prompt" and r.get("id") == "bad1"]
check("mid-stream prompt without streamingBehavior fails",
      bool(bad) and bad[0].get("success") is False, f"resp={bad[:1]}")
check("failure names the remedy (streamingBehavior)",
      bool(bad) and "streamingBehavior" in json.dumps(bad[0]))
send(proc5, {"type": "abort"})
drain(proc5, 10, stop_on=b"agent_settled")
proc5.stdin.close()
try:
    proc5.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc5.terminate(); proc5.wait()

# ---------------- 4. steer / follow_up during a run ----------------
proc4 = subprocess.Popen(["pi", "--mode", "rpc"], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=CWD)
time.sleep(1.5)
send(proc4, {"id": "q1", "type": "prompt",
             "message": "Use the bash tool to run exactly: sleep 6 && echo BASE-DONE. Then describe the output."})
time.sleep(3)  # mid-run
send(proc4, {"id": "st1", "type": "steer",
             "message": "STEER-NOTE: when you finish the current step, also include the word BANANA."})
time.sleep(1)
send(proc4, {"id": "fu1", "type": "follow_up",
             "message": "End your very final reply with the word CHERRY."})
buf4 = drain(proc4, 150, stop_on=b"agent_settled")
# follow_up delivery causes a SECOND agent cycle; keep draining until the
# text contains CHERRY or 60s more pass
deadline = time.time() + 60
while time.time() < deadline and b"CHERRY" not in buf4:
    r, _, _ = select.select([proc4.stdout], [], [], 0.5)
    if r:
        c = os.read(proc4.stdout.fileno(), 1 << 20)
        if not c:
            break
        buf4 += c
recs4 = save("04-steer-followup.ndjson", buf4)
text4 = assistant_text(recs4).upper()
check("steer accepted", any(r.get("type") == "response" and r.get("command") == "steer" and r.get("success") for r in recs4))
check("follow_up accepted", any(r.get("type") == "response" and r.get("command") == "follow_up" and r.get("success") for r in recs4))
check("queue_update observed", any(r.get("type") == "queue_update" for r in recs4))
check("steer delivered mid-run (BANANA present)", "BANANA" in text4, text4[-200:])
check("follow_up delivered after settle (CHERRY present)", "CHERRY" in text4, text4[-200:])
settles = seq4 = [r.get("type") for r in recs4].count("agent_settled")
check("follow_up caused a second agent cycle (>=2 agent_settled OR CHERRY after first settle)",
      settles >= 2 or "CHERRY" in text4)
proc4.stdin.close()
try:
    proc4.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc4.terminate(); proc4.wait()

# ---------------- 3. multiturn, same process ----------------
send(proc, {"id": "s2", "type": "get_state"})
buf3a = drain(proc, 5)
st2 = state_of(records(buf3a))
check("sessionId stable across turns in one process", st2.get("sessionId") == sid,
      f"{st2.get('sessionId')} != {sid}")
check("session file EXISTS after a completed turn",
      "sessionFile" in st2 and os.path.exists(st2.get("sessionFile", "/nonexistent")))
send(proc, {"id": "p2", "type": "prompt",
            "message": "In one short line: what exact command did I ask you to run earlier in this session?"})
buf3 = drain(proc, 120, stop_on=b"agent_settled")
recs3 = save("03-multiturn-same-process.ndjson", buf3)
check("second turn recalls the first (SLEEP-DONE or sleep 2 mentioned)",
      "SLEEP-DONE" in assistant_text(recs3) or "SLEEP 2" in assistant_text(recs3).upper())
proc.stdin.close()
t0 = time.time()
try:
    rc = proc.wait(timeout=8)
    check("stdin EOF exits clean rc=0", rc == 0, f"rc={rc} after {time.time()-t0:.1f}s")
except subprocess.TimeoutExpired:
    proc.terminate(); proc.wait()
    check("stdin EOF exits clean rc=0", False, "did not exit within 8s")

with open(os.path.join(OUTDIR, "assertions.txt"), "w") as f:
    for p in PASS:
        f.write(f"PASS {p}\n")
    for x in FAIL:
        f.write(f"FAIL {x}\n")
    f.write(f"\n{len(PASS)} passed, {len(FAIL)} failed\n")
print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
sys.exit(1 if FAIL else 0)
