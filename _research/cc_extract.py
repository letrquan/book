import re, sys, io

BIN = r"I:/Tools/npm-global/node_modules/@anthropic-ai/.claude-code-pTXJSofV/node_modules/@anthropic-ai/claude-code-win32-x64/claude.exe"

with open(BIN, "rb") as f:
    data = f.read()

# Decode preserving valid UTF-8 (box-drawing/braille are multibyte); drop invalid bytes.
text = data.decode("utf-8", errors="ignore")
print("decoded len:", len(text), file=sys.stderr)

OUT = io.StringIO()

def dump(label, iterable, limit=2000):
    OUT.write(f"\n===== {label} =====\n")
    n = 0
    for x in iterable:
        if n >= limit:
            OUT.write(f"... (truncated at {limit})\n")
            break
        OUT.write(repr(x) + "\n")
        n += 1
    OUT.write(f"[count shown: {n}]\n")

# --- Spinner frames: find arrays/strings of Braille or other spinner glyphs ---
# Braille spinner frames look like sequences "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
braille = re.findall(r"[\u2800-\u28FF]{2,40}", text)
dump("braille_runs", braille, 100)

# Also single-braille-char repeats inside arrays e.g. '⠋','⠙',...
# Find JS string-literal arrays of single braille chars
braille_lit = re.findall(r"(?:'[\u2800-\u28FF]',?\s*){3,40}", text)
dump("braille_array_literals", braille_lit, 100)

# Box-drawing runs (borders)
box = re.findall(r"[\u2500-\u257F]{2,200}", text)
dump("box_drawing_runs", box, 200)

# Block elements (bars/progress)
blocks = re.findall(r"[\u2580-\u259F]{1,200}", text)
dump("block_element_runs", blocks, 100)

# Geometric shapes / stars / diamonds used as avatars/prefix
geom = re.findall(r"[\u25A0-\u25FF\u2605-\u2606\u2726-\u2727\u2B50\u2756\u2755\u2754\u2728\u2744\u25C6\u25C7\u25B2\u25BC\u25CF\u25CB\u25AA\u25AB]{1,40}", text)
dump("geometric_shapes_stars", geom, 200)

# Arrows
arrows = re.findall(r"[\u2190-\u21FF\u2794-\u27BF\u2B05-\u2B07]{1,40}", text)
dump("arrows", arrows, 80)

# Emoji
emoji = re.findall(r"[\U0001F000-\U0001FAFF\U00002600-\U000027BF]{1,40}", text)
dump("emoji", emoji, 120)

# Hex colors
hexcolors = sorted(set(re.findall(r"#[0-9A-Fa-f]{6}\b", text)))
dump("hex_colors", hexcolors, 400)

# ANSI 256 / rgb color tuples
rgbs = sorted(set(re.findall(r"rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)", text)))
dump("rgb_colors", rgbs, 400)

# chalk/ansi-256 numbers near 'color'?
# Look for known chalk hex maps

with open(r"I:/MyProject/02-AI-ML-Projects/book/_research/cc_strings_part1.txt", "w", encoding="utf-8") as f:
    f.write(OUT.getvalue())
print("wrote part1", file=sys.stderr)
