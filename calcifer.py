#!/usr/bin/env python3
"""
Calcifer - the little fire demon from Howl's Moving Castle.

A round, blobby fire-ball with flickering flame-tongues on top, a big
expressive face (wide-set eyes, arched brows, wide grin), rising embers,
and true fire colors.

Run:        python calcifer.py
Snapshot:   python calcifer.py snapshot      (print one plain frame)
Quit:       press q or Esc  (or Ctrl-C)
"""

import math
import os
import random
import sys
import time

# ---------------------------------------------------------------- canvas
W, H = 42, 20
FPS = 30

# fire density ramp, low (dim) -> high (bright)
RAMP = " .:-=+*o#%@"

# fire color stops: (intensity, (r,g,b))
STOPS = [
    (0.00, ( 18,   8,   6)),
    (0.12, ( 70,  10,   5)),
    (0.30, (190,  35,   8)),
    (0.50, (235,  95,  15)),
    (0.68, (255, 150,  25)),
    (0.84, (255, 215,  60)),
    (1.00, (255, 245, 200)),
]
BG = (10, 8, 22)          # dark navy background
FACE = (24, 12, 6)        # dark features for the face


# ---------------------------------------------------------------- helpers
def lerp(a, b, t):
    return a + (b - a) * t


def color_at(t):
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t <= t1:
            u = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
            return (int(lerp(c0[0], c1[0], u)),
                    int(lerp(c0[1], c1[1], u)),
                    int(lerp(c0[2], c1[2], u)))
    return STOPS[-1][1]


def char_at(t):
    if t < 0.05:
        return ' '
    idx = int(t * (len(RAMP) - 1))
    if idx < 0:
        idx = 0
    if idx > len(RAMP) - 1:
        idx = len(RAMP) - 1
    return RAMP[idx]


def blend(c1, c2, k):
    k = 0.0 if k < 0 else 1.0 if k > 1 else k
    return (int(lerp(c1[0], c2[0], k)),
            int(lerp(c1[1], c2[1], k)),
            int(lerp(c1[2], c2[2], k)))


# ---------------------------------------------------------------- flame
# Calcifer: a round blob of fire with flickering flame-tongues on top.
def flame_intensity(x, y, t):
    cx = (W - 1) / 2.0
    # round blob body (2D ellipse falloff) -> reads as a fire-ball, not a teardrop
    bx = cx + math.sin(t * 1.1) * 0.7
    by = H * 0.58
    rx = W * 0.205
    ry = H * 0.30
    dxn = (x - bx) / rx
    dyn = (y - by) / ry
    d = math.sqrt(dxn * dxn + dyn * dyn)
    blob = 1.0 - d
    if blob < 0.0:
        blob = 0.0
    blob = blob ** 1.25
    blob *= 0.86 + 0.14 * math.sin(t * 7.0 + x * 0.5 + y * 0.4)
    vheat = 0.62 + 0.45 * (y / H)
    intensity = blob * vheat

    # flickering flame-tongues rising above the blob
    if y < by:
        base_y = by - ry * 0.55
        for k, off in enumerate([-0.55, 0.0, 0.55]):
            sx = cx + off * rx + math.sin(t * 1.9 + k * 1.7) * 0.7
            amp = 3.0 + 1.6 * math.sin(t * 3.6 + k * 2.1)
            tip_y = base_y - amp
            if y > base_y or y < tip_y:
                continue
            sdx = abs(x - sx)
            frac = (y - tip_y) / (base_y - tip_y)   # 0 tip .. 1 base
            sw = 1.2 + 0.7 * frac + 0.3 * math.sin(t * 7.0 + k)
            if sdx < sw:
                s = (1.0 - sdx / sw) * frac
                if s > intensity:
                    intensity = s * 0.92

    # two little side licks (like stubby arms)
    mid = by
    if abs(y - mid) < 2.2:
        for k, off in enumerate([-1.0, 1.0]):
            sx = cx + off * (rx + 0.6) + math.sin(t * 4.0 + k) * 0.5
            sdx = abs(x - sx)
            if sdx < 1.4:
                s = (1.0 - sdx / 1.4) * 0.55
                if s > intensity:
                    intensity = s

    if intensity < 0.0:
        intensity = 0.0
    if intensity > 1.0:
        intensity = 1.0
    return intensity


# ---------------------------------------------------------------- face
# feature positions (computed once for the fixed canvas)
CX = (W - 1) / 2.0
FACE_BROWS = 8
FACE_EYES = 10
FACE_MOUTH = 12
BROW_L, BROW_R = 17, 24          # '/' and '\'  (arched, just outside the eyes)
EYE_L, EYE_R = 18, 23            # big round eyes, wide-set
MOUTH0, MOUTH1 = 14, 26          # wide grin span (inclusive)
FACE_BBOX = (7, 13, 13, 27)       # (r0,c0,r1,c1) - keep embers off the face


def stamp_face(chars, fgs, blink):
    eye = '^' if blink else '\u25c9'   # ^ when blinking, else \u25c9 (◉)
    # arched brows
    chars[FACE_BROWS * W + BROW_L] = '/'
    fgs[FACE_BROWS * W + BROW_L] = FACE
    chars[FACE_BROWS * W + BROW_R] = '\\'
    fgs[FACE_BROWS * W + BROW_R] = FACE
    # big round eyes (the focal point)
    chars[FACE_EYES * W + EYE_L] = eye
    fgs[FACE_EYES * W + EYE_L] = FACE
    chars[FACE_EYES * W + EYE_R] = eye
    fgs[FACE_EYES * W + EYE_R] = FACE
    # wide jagged grin with a little tongue in the middle
    half = (MOUTH1 - MOUTH0) // 2
    mouth = '\\' + '_' * (half - 1) + '^' + '_' * (half - 1) + '/'
    for i, ch in enumerate(mouth):
        chars[FACE_MOUTH * W + MOUTH0 + i] = ch
        fgs[FACE_MOUTH * W + MOUTH0 + i] = FACE


# ---------------------------------------------------------------- embers
class Embers:
    def __init__(self):
        self.p = []
        self.acc = 0.0

    def update(self, dt, t):
        self.acc += dt
        while self.acc > 0.05:
            self.acc -= 0.05
            if random.random() < 0.8 and len(self.p) < 50:
                self.p.append({
                    'x': CX + random.uniform(-W * 0.28, W * 0.28),
                    'y': random.uniform(H * 0.20, H * 0.55),
                    'vx': random.uniform(-0.35, 0.35),
                    'vy': random.uniform(-1.4, -0.6),
                    'life': 0.0,
                    'max': random.uniform(1.1, 2.3),
                    'ph': random.uniform(0, 6.28),
                })
        out = []
        r0, c0, r1, c1 = FACE_BBOX
        for e in self.p:
            e['x'] += e['vx'] * dt + math.sin(t * 5 + e['ph'] + e['life'] * 9) * 0.12
            e['y'] += e['vy'] * dt
            e['vy'] *= 0.99
            e['life'] += dt
            if e['life'] < e['max'] and e['y'] > -1:
                out.append(e)
        self.p = out

    def stamp(self, chars, fgs):
        r0, c0, r1, c1 = FACE_BBOX
        for e in self.p:
            x, y = int(round(e['x'])), int(round(e['y']))
            if not (0 <= x < W and 0 <= y < H):
                continue
            if r0 <= y <= r1 and c0 <= x <= c1:
                continue
            ratio = e['life'] / e['max']          # 0 young -> 1 old
            ei = 0.6 + 0.4 * (1 - ratio)
            col = color_at(ei)
            # fade in/out
            if e['life'] < 0.15:
                a = e['life'] / 0.15
            elif ratio > 0.8:
                a = max(0.0, 1 - (ratio - 0.8) / 0.2)
            else:
                a = 1.0
            col = (int(col[0] * a), int(col[1] * a), int(col[2] * a))
            if ratio < 0.35:
                ch = '*'
            elif ratio < 0.7:
                ch = '+'
            else:
                ch = '.'
            chars[y * W + x] = ch
            fgs[y * W + x] = col


# ---------------------------------------------------------------- frame
def render_frame(t, blink, embers, plain=False):
    chars = [' '] * (W * H)
    fgs = [BG] * (W * H)

    for y in range(H):
        for x in range(W):
            ti = flame_intensity(x, y, t)
            if ti <= 0.0:
                continue
            idx = y * W + x
            chars[idx] = char_at(ti)
            col = color_at(ti)
            p = y / (H - 1)
            if p > 0.80:                       # subtle magical blue base
                col = blend(col, (55, 90, 230), 0.28 * (p - 0.80) / 0.20)
            fgs[idx] = col

    stamp_face(chars, fgs, blink)
    embers.stamp(chars, fgs)

    if plain:
        lines = []
        for y in range(H):
            lines.append(''.join(chars[y * W:(y + 1) * W]))
        return '\n'.join(lines)

    # colored: coalesce runs of the same color
    out = []
    prev = None
    for y in range(H):
        row_chars = chars[y * W:(y + 1) * W]
        row_cols = fgs[y * W:(y + 1) * W]
        line = []
        for ch, col in zip(row_chars, row_cols):
            if col != prev:
                line.append('\x1b[38;2;%d;%d;%dm' % col)
                prev = col
            line.append(ch)
        out.append(''.join(line))
    return '\r\n'.join(out) + '\x1b[0m'


CAPTIONS = [
    "  \u2665  Calcifer  \u2665",
    "  \"May it never go out.\"",
    "  heh heh heh...",
    "  \u266a ~ crackle ~ \u266a",
    "  a heart for a flame",
]


# ---------------------------------------------------------------- terminal
def enable_windows_vt():
    if os.name != 'nt':
        return
    try:
        import ctypes
        k = ctypes.windll.kernel32
        h = k.GetStdHandle(-11)
        mode = ctypes.c_uint32()
        if k.GetConsoleMode(h, ctypes.byref(mode)):
            k.SetConsoleMode(h, mode.value | 0x0004)
    except Exception:
        pass


def get_terminal_size():
    try:
        import shutil
        return shutil.get_terminal_size((80, 24))
    except Exception:
        return 80, 24


class KeyReader:
    def __init__(self):
        self.win = os.name == 'nt'
        self.fd = None
        self.old = None
        if not self.win:
            try:
                import termios
                import tty
                self.fd = sys.stdin.fileno()
                self.old = termios.tcgetattr(self.fd)
                tty.setcbreak(self.fd)
            except Exception:
                self.fd = None

    def read(self):
        try:
            if self.win:
                import msvcrt
                if msvcrt.kbhit():
                    return msvcrt.getwch()
            else:
                import select
                dr, _, _ = select.select([sys.stdin], [], [], 0)
                if dr:
                    return sys.stdin.read(1)
        except Exception:
            pass
        return None

    def restore(self):
        if self.fd is not None and self.old is not None:
            try:
                import termios
                termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old)
            except Exception:
                pass


# ---------------------------------------------------------------- main
def main():
    args = sys.argv[1:]

    if args and args[0] == 'snapshot':
        embers = Embers()
        sys.stdout.write(render_frame(0.0, False, embers, plain=True) + '\n')
        return

    max_frames = None
    for a in args:
        if a.startswith('frames='):
            try:
                max_frames = int(a.split('=', 1)[1])
            except ValueError:
                pass

    enable_windows_vt()
    kr = KeyReader()

    tw, th = get_terminal_size()
    pad_left = max(0, (tw - W) // 2)
    start_row = max(1, (th - H - 2) // 2)

    sys.stdout.write('\x1b[?25l')                       # hide cursor
    sys.stdout.write('\x1b]0;Calcifer\x07')             # title
    sys.stdout.write('\x1b[48;2;%d;%d;%dm\x1b[2J' % BG) # bg + clear
    sys.stdout.flush()

    embers = Embers()
    t0 = time.monotonic()
    last = t0
    frame = 0
    next_blink = 2.5
    blink_until = 0.0
    cap_i = 0
    cap_t = 0.0

    try:
        while True:
            now = time.monotonic()
            dt = now - last
            last = now
            t = now - t0

            if now > blink_until and t > next_blink:
                blink_until = t + 0.14
                next_blink = t + random.uniform(2.5, 5.0)
            blink = t < blink_until

            embers.update(dt, t)

            buf = ['\x1b[%d;1H' % start_row]
            pad = ' ' * pad_left
            body = render_frame(t, blink, embers, plain=False)
            for line in body.split('\r\n'):
                buf.append(pad)
                buf.append(line)
                buf.append('\r\n')

            if t - cap_t > 3.0:
                cap_t = t
                cap_i = (cap_i + 1) % len(CAPTIONS)
            cap = CAPTIONS[cap_i]
            capcol = (180, 110, 60)
            cap_left = max(0, (tw - len(cap)) // 2)
            buf.append('\x1b[%d;1H' % (start_row + H + 1))
            buf.append(' ' * cap_left)
            buf.append('\x1b[38;2;%d;%d;%dm%s\x1b[0m' % (capcol[0], capcol[1], capcol[2], cap))

            sys.stdout.write(''.join(buf))
            sys.stdout.flush()

            k = kr.read()
            if k in ('q', 'Q', '\x1b', '\x03'):
                break

            frame += 1
            if max_frames is not None and frame >= max_frames:
                break

            elapsed = time.monotonic() - now
            sleep = (1.0 / FPS) - elapsed
            if sleep > 0:
                time.sleep(sleep)
    except KeyboardInterrupt:
        pass
    finally:
        kr.restore()
        sys.stdout.write('\x1b[0m\x1b[?25h\x1b[2J\x1b[H')
        sys.stdout.write('  \x1b[38;2;255;180;40m\u2665 Calcifer curls back into the embers \x1b[0m\n\n')
        sys.stdout.flush()


if __name__ == '__main__':
    main()
