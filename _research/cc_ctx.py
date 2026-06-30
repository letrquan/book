import re, sys

BIN = r"I:/Tools/npm-global/node_modules/@anthropic-ai/.claude-code-pTXJSofV/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe"
with open(BIN, "rb") as f:
    data = f.read()
text = data.decode("utf-8", errors="ignore")

def ctx(needle, before=300, after=600, maxhits=8, flags=re.IGNORECASE):
    out = []
    for m in re.finditer(needle, text, flags):
        s = max(0, m.start()-before)
        e = min(len(text), m.end()+after)
        snippet = text[s:e]
        # collapse non-printable
        snippet = "".join(c if (c=="\n" or 32<=ord(c)<0x10000 and c not in "\r\t") else "·" for c in snippet)
        out.append(snippet)
        if len(out) >= maxhits:
            break
    return out

TERMS = [
    # spinner
    r"spinner", r"\bframes\b", r"interval",
    # themes
    r"daltonized", r"protanopia", r"deuteranopia", r"tritanopia",
    r"dark-blindness", r"light-blindness", r"dark-ansi", r"light-ansi",
    r"themeName", r"\btheme\b",
    # diff / edit
    r"Output is truncated", r"truncated", r"Updated", r"\blines\b",
    # thinking
    r"[Tt]hinking",
    # status line
    r"Context left", r"Context\b", r"\bCost\b", r"\btokens\b",
    # task / subagent
    r"\bTask\b", r"subagent", r"Subagent",
    # prompt / input
    r"esc to interrupt", r"interrupt",
]

with open(r"I:/MyProject/02-AI-ML-Projects/book/_research/cc_ctx.txt", "w", encoding="utf-8") as f:
    for t in TERMS:
        f.write("\n\n########################################\n")
        f.write(f"### TERM: {t}\n")
        f.write("########################################\n")
        hits = ctx(t, maxhits=6)
        if not hits:
            f.write("(no matches)\n")
        for i, h in enumerate(hits):
            f.write(f"\n--- hit {i+1} ---\n{h}\n")
print("done", file=sys.stderr)
