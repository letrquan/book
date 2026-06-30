import re, sys
BIN = r"I:/Tools/npm-global/node_modules/@anthropic-ai/.claude-code-pTXJSofV/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe"
with open(BIN,"rb") as f: data=f.read()
text=data.decode("utf-8",errors="ignore")

def clean(s): return "".join(c if (c=="\n" or 32<=ord(c)<0x11000 and c not in "\r\t") else "·" for c in s)

def find_assign(varnames, after=1400, maxhits=3):
    out=[]
    for v in varnames:
        # match var as assignment target: "NAME=" not preceded by alnum/_
        pat = re.compile(r"(?<![A-Za-z0-9_$])"+re.escape(v)+r"\s*=\s*")
        for m in pat.finditer(text):
            s=m.start(); e=min(len(text),m.end()+after)
            out.append((v,m.start(),clean(text[s:e])))
            if len([x for x in out if x[0]==v])>=maxhits: break
    return out

themes=["BZu","NZu","$Zu","UZu","FZu","jZu","sQc","ZO","e1"]
res=find_assign(themes, after=1800, maxhits=2)

with open(r"I:/MyProject/02-AI-ML-Projects/book/_research/cc_themes.txt","w",encoding="utf-8") as f:
    for v,pos,snip in res:
        f.write(f"\n===== {v} @offset {pos} =====\n{snip}\n")
print("themes written", file=sys.stderr)

# Spinner: search for compact arrays of circle/fisheye glyphs.
# Likely frames use one of: ◐◓◑◒◴◵◶◷◎◉◍◌○●
glyphset="◐◓◑◒◴◵◶◷◎◉◍○●✻✶✦✳✲✱"
pat=re.compile("["+glyphset+r"]{1}(?:[\"'],?\s*[\"']?["+glyphset+"]){2,30}")
spins=pat.findall(text)
with open(r"I:/MyProject/02-AI-ML-Projects/book/_research/cc_spinner.txt","w",encoding="utf-8") as f:
    seen=set()
    for s in spins:
        key=s
        if key in seen: continue
        seen.add(key)
        f.write(repr(s)+"\n")
    f.write(f"\n[unique spin candidates: {len(seen)}]\n")
print("spinner written", file=sys.stderr)
