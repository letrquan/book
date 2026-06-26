import re, sys, collections

PATH = r"C:/Users/ADMIN/.local/share/claude/versions/2.1.193"
data = open(PATH, "rb").read()
print("binary size:", len(data))

# Ranges of interest
ranges = {
    "box_drawing":      (0x2500, 0x257F),
    "geometric_shapes": (0x25A0, 0x25FF),
    "misc_symbols":     (0x2600, 0x26FF),
    "dingbats":         (0x2700, 0x27BF),
    "braille":          (0x2800, 0x28FF),
    "arrows":           (0x2190, 0x21FF),
    "cjk_symbols":      (0x3000, 0x303F),
    "letterlike":       (0x2100, 0x214F),
    "private_use":      (0xE000, 0xF8FF),
    "powerline":        (0xE0A0, 0xE0D4),
}

# Decode whole binary as utf-8 with errors ignored to find raw unicode
try:
    text = data.decode("utf-8", errors="ignore")
except Exception:
    text = data.decode("latin-1", errors="ignore")

print("decoded len:", len(text))

freq = collections.Counter()
contexts = {}  # cp -> list of short context strings
for ch in text:
    cp = ord(ch)
    for name,(lo,hi) in ranges.items():
        if lo <= cp <= hi:
            freq[(name,cp)] += 1
            if len(contexts.get(cp,[])) < 3:
                idx = text.find(ch)
                # find a few occurrences
                pass

# Better: scan for occurrences with context
contexts = collections.defaultdict(list)
i = 0
# Build a quick lookup of codepoints present
present = set(c for c in text if any(lo<=ord(c)<=hi for _,(lo,hi) in ranges.items()))
# Re-scan to capture context for first few occurrences of each interesting cp
seen_count = collections.Counter()
for idx, ch in enumerate(text):
    cp = ord(ch)
    interesting = None
    for name,(lo,hi) in ranges.items():
        if lo <= cp <= hi:
            interesting = name; break
    if interesting and seen_count[cp] < 2:
        s = max(0, idx-40); e = min(len(text), idx+40)
        ctx = text[s:e]
        # keep only printable-ish
        ctx = ''.join(c if 32 <= ord(c) < 127 or ord(c) >= 0x2000 else '.' for c in ctx)
        contexts[cp].append(ctx)
        seen_count[cp]+=1

print("\n=== CODEPOINT FREQUENCY (range, cp, char, count) ===")
for (name,cp),cnt in sorted(freq.items(), key=lambda x:-x[1]):
    ch = chr(cp)
    sample = contexts.get(cp,[])
    s0 = sample[0] if sample else ""
    print(f"{name:18s} U+{cp:04X} '{ch}'  x{cnt}   ctx0= ...{s0}...")
