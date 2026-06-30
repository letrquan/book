import re, sys
BIN = r"I:/Tools/npm-global/node_modules/@anthropic-ai/.claude-code-pTXJSofV/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe"
with open(BIN,"rb") as f: data=f.read()
text=data.decode("utf-8",errors="ignore")

def grab_object(name):
    # find "name={..." then balance braces/brackets/strings
    m=re.search(r"(?<![A-Za-z0-9_$])"+re.escape(name)+r"\s*=\s*\{", text)
    if not m: return None
    i=m.end()-1  # at '{'
    depth=0; j=i; n=len(text); instr=None; esc=False
    while j<n:
        c=text[j]
        if instr:
            if esc: esc=False
            elif c=="\\": esc=True
            elif c==instr: instr=None
        else:
            if c in "\"'`": instr=c
            elif c=="{": depth+=1
            elif c=="}":
                depth-=1
                if depth==0:
                    return text[i:j+1]
        j+=1
    return None

names={"dark":"BZu","light":"NZu","light-ansi":"$Zu","dark-ansi":"UZu","light-daltonized":"FZu","dark-daltonized":"jZu"}
with open(r"I:/MyProject/02-AI-ML-Projects/book/_research/cc_full_themes.txt","w",encoding="utf-8") as f:
    for theme,var in names.items():
        obj=grab_object(var)
        f.write(f"\n===== {theme} ({var}) =====\n")
        f.write((obj or "(not found)")+"\n")
print("full themes written", file=sys.stderr)

# Spinner interval: search for number near spinner frames or 'interval'
# Also find usage of avatar glyph var 'fq' and prompt prefix.
def ctx(needle, before=120, after=260, maxhits=12, flags=0):
    out=[]
    for m in re.finditer(needle, text, flags):
        s=max(0,m.start()-before); e=min(len(text),m.end()+after)
        snip="".join(c if (c=="\n" or 32<=ord(c)<0x11000 and c not in "\r\t") else "·" for c in text[s:e])
        out.append((m.start(),snip))
        if len(out)>=maxhits: break
    return out

with open(r"I:/MyProject/02-AI-ML-Projects/book/_research/cc_usage.txt","w",encoding="utf-8") as f:
    for label,pat in [
        ("avatar_fq_usage", r"(?<![A-Za-z0-9_$])fq\b"),
        ("spinner_interval", r"interval\s*[:=]\s*\d{1,4}"),
        ("spinner_module", r"getSpinner|spinner\b"),
        ("truncated_phrase", r"truncat\w*"),
        ("updated_lines", r"Updated\b[^\n]{0,80}"),
        ("thinking_label", r"[Tt]hinking"),
        ("cost_field", r"\bCost\b"),
        ("context_field", r"Context left|context window|Context:"),
        ("esc_interrupt", r"esc to interrupt|to interrupt|interrupt"),
        ("prompt_prefix_glyph", r"❯|❯❯|❭"),
        ("brief_label", r"\bYou\b|\bClaude\b"),
    ]:
        f.write(f"\n\n##### {label} #####\n")
        for pos,snip in ctx(pat):
            f.write(f"@{pos}\n{snip}\n----\n")
print("usage written", file=sys.stderr)
