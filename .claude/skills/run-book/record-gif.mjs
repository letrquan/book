#!/usr/bin/env node
/**
 * Turn a driver recording (`driver.mjs --record <file>`) into an animated GIF,
 * an animated WebP, or a PNG of its last frame, chosen by the output extension.
 *
 *   node record-gif.mjs rec.json out.gif|out.webp|out.png
 *        [--fps 12] [--max-hold 1800] [--end-hold 3500] [--speed 1] [--scale 1]
 *        [--start-at <regex>] [--until <regex> --after <ms>] [--from <ms>] [--to <ms>]
 *        [--rows <a>:<b>] [--title <text>] [--colours 96]
 *
 * The PTY stream is replayed into @xterm/headless, sampled at `--fps`, and each
 * distinct screen is drawn as HTML (colours and attributes kept, the same
 * rendering as the driver's `shotpng`), screenshotted by headless Edge or
 * Chromium in batches, and joined by sharp. Identical frames collapse into one
 * longer frame; a pause longer than `--max-hold` is cut to it. `--rows` crops
 * to screen rows a..b-1 (negative from the bottom) and `--title` adds a window
 * title bar. A `.png` is the final frame alone: `--until` picks the moment.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const require = createRequire(join(ROOT, 'package.json'));
const { Terminal } = require('@xterm/headless');
const sharp = require('sharp');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const [recPath, outPath] = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const FPS = Number(opt('fps', '12'));
const MAX_HOLD = Number(opt('max-hold', '1800'));
const END_HOLD = Number(opt('end-hold', '3500'));
const FROM = Number(opt('from', '0'));
const TO = Number(opt('to', 'Infinity'));
const SPEED = Number(opt('speed', '1'));
const SCALE = Number(opt('scale', '1'));
const COLOURS = Number(opt('colours', '96'));

const rec = JSON.parse(readFileSync(recPath, 'utf8'));
const { cols, rows } = rec;

// --- screen -> HTML (the driver's shotpng rendering) -------------------------
const ANSI16 = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
];
function paletteColor(i) {
  if (i < 16) return ANSI16[i];
  if (i < 232) {
    const n = i - 16;
    const level = (v) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${level(Math.floor(n / 36))},${level(Math.floor(n / 6) % 6)},${level(n % 6)})`;
  }
  const g = 8 + (i - 232) * 10;
  return `rgb(${g},${g},${g})`;
}
function cellColor(cell, fg) {
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return null;
  const v = fg ? cell.getFgColor() : cell.getBgColor();
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return `#${v.toString(16).padStart(6, '0')}`;
  return paletteColor(v);
}
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function blockElementStyle(ch, fg, bg) {
  const strip = (w, h, x, y) =>
    `background:${bg} linear-gradient(${fg},${fg}) no-repeat ${x} ${y}/${w} ${h}`;
  switch (ch) {
    case '█': return `background:${fg}`;
    case '▀': return `background:linear-gradient(${fg} 50%,${bg} 50%)`;
    case '▄': return `background:linear-gradient(${bg} 50%,${fg} 50%)`;
    case '▌': return `background:linear-gradient(to right,${fg} 50%,${bg} 50%)`;
    case '▐': return `background:linear-gradient(to right,${bg} 50%,${fg} 50%)`;
    case '│': return strip('1px', '100%', '50%', '0');
    case '─': return strip('100%', '1px', '0', '50%');
    case '━': return strip('100%', '2px', '0', '50%');
    default: return null;
  }
}
const DEFAULT_FG = '#d4d4d4';
const DEFAULT_BG = '#0c0c0c';
// `--rows a:b` draws only screen rows a..b-1 (negative counts from the bottom).
const [ROW_FIRST, ROW_END] = (() => {
  const spec = opt('rows', null);
  if (!spec) return [0, rows];
  const [a, b] = spec.split(':').map((v) => (v === '' ? null : Number(v)));
  const at = (v, fallback) => (v === null ? fallback : v < 0 ? rows + v : v);
  return [at(a, 0), at(b, rows)];
})();
const shownRows = ROW_END - ROW_FIRST;

function screenRowsHtml(term) {
  const out = [];
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  for (let y = ROW_FIRST; y < ROW_END; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    let html = '';
    for (let x = 0; x < cols; x++) {
      if (!line) break;
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      let fg = cellColor(cell, true) ?? DEFAULT_FG;
      let bg = cellColor(cell, false);
      if (cell.isInverse()) [fg, bg] = [bg ?? DEFAULT_BG, fg];
      const style = [`color:${fg}`];
      if (bg) style.push(`background:${bg}`);
      if (cell.isBold()) style.push('font-weight:700');
      if (cell.isDim()) style.push('opacity:.55');
      if (cell.isItalic()) style.push('font-style:italic');
      if (cell.isUnderline()) style.push('text-decoration:underline');
      const chars = cell.getChars() || ' ';
      const block = blockElementStyle(chars, fg, bg ?? 'transparent');
      if (block) {
        html += `<span class="b" style="${block}"></span>`;
        continue;
      }
      const wide = cell.getWidth() === 2 ? ' class="w"' : '';
      html += `<span${wide} style="${style.join(';')}">${escapeHtml(chars)}</span>`;
    }
    out.push(`<div class="r">${html || ' '}</div>`);
  }
  return out.join('');
}

// --- sample the stream --------------------------------------------------------
// A frame the renderer writes in several chunks must not be sampled half-drawn:
// chunks closer than BURST_MS belong to one burst, and a sample takes whole bursts.
const BURST_MS = 6;
const bursts = [];
for (const [t, d] of rec.chunks) {
  const last = bursts.at(-1);
  if (last && t - last.end < BURST_MS) {
    last.data += d;
    last.end = t;
  } else bursts.push({ start: t, end: t, data: d });
}

// `--start-at <regex>` starts sampling once the screen first matches it, and
// `--until <regex>` stops `--after` ms after the screen first matches that.
const START_AT = opt('start-at', null) && new RegExp(opt('start-at', null));
const UNTIL = opt('until', null) && new RegExp(opt('until', null));
const AFTER = Number(opt('after', '0'));
const screenText = () =>
  Array.from({ length: rows }, (_, y) =>
    term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString(true) ?? '',
  ).join('\n');

const term = new Terminal({ cols, rows, allowProposedApi: true, convertEol: true });
const write = (s) => new Promise((res) => term.write(s, res));
const frames = []; // { html, ms }
const step = 1000 / FPS;
let endTime = Math.min(TO, bursts.at(-1).end);
let started = !START_AT;
let next = 0;
for (let t = 0; t <= endTime + step; t += step) {
  while (next < bursts.length && bursts[next].end <= t) await write(bursts[next++].data);
  if (t < FROM) continue;
  if (!started) {
    if (!START_AT.test(screenText())) continue;
    started = true;
  }
  if (UNTIL && endTime === Math.min(TO, bursts.at(-1).end) && UNTIL.test(screenText())) {
    endTime = t + AFTER;
  }
  const html = screenRowsHtml(term);
  const last = frames.at(-1);
  if (last && last.html === html) last.ms += step;
  else frames.push({ html, ms: step });
}
term.dispose();
for (const frame of frames) frame.ms = Math.min(frame.ms / SPEED, MAX_HOLD);
frames.at(-1).ms = END_HOLD;
console.log(`[gif] ${frames.length} distinct frames, ${Math.round(frames.reduce((a, f) => a + f.ms, 0))}ms`);

// --- render ---------------------------------------------------------------------
// Cascadia Mono advances 0.586em: 8.79px a column at 15px.
const PAD = 14;
const width = Math.ceil(cols * 8.79 + PAD * 2);
// `--title <text>` adds a window title bar, so the image reads as a terminal.
const TITLE = opt('title', null);
const BAR = TITLE ? 30 : 0;
const frameH = shownRows * 18 + PAD * 2 + BAR;
const browser = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => existsSync(p));
if (!browser) throw new Error('no Chromium-family browser to render frames');

const work = mkdtempSync(join(tmpdir(), 'book-gif-'));
function screenshot(htmlPath, pngPath, height) {
  const profile = mkdtempSync(join(tmpdir(), 'book-gif-profile-'));
  return new Promise((res, rej) => {
    const child = spawn(
      browser,
      [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--disable-lcd-text',
        `--force-device-scale-factor=${SCALE}`, `--user-data-dir=${profile}`,
        `--screenshot=${resolve(pngPath)}`, `--window-size=${width},${height}`,
        `file:///${resolve(htmlPath).replace(/\\/g, '/')}`,
      ],
      { stdio: 'ignore' },
    );
    child.on('exit', () => {
      rmSync(profile, { recursive: true, force: true });
      res();
    });
    child.on('error', rej);
  });
}

const bar = TITLE
  ? `<div class="bar"><span class="dots"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></span>${escapeHtml(TITLE)}</div>`
  : '';
// A still (`.png` output) is the final frame alone.
if (outPath.endsWith('.png')) frames.splice(0, frames.length - 1);
const BATCH = Math.max(1, Math.floor(12000 / frameH));
const pngs = [];
for (let i = 0; i < frames.length; i += BATCH) {
  const batch = frames.slice(i, i + BATCH);
  const htmlPath = join(work, `batch-${i}.html`);
  const pngPath = join(work, `batch-${i}.png`);
  writeFileSync(
    htmlPath,
    `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:${DEFAULT_BG}}
.f{height:${frameH}px;box-sizing:border-box;overflow:hidden}
.p{padding:${PAD}px}
.bar{height:${BAR}px;background:#1d1d1f;border-bottom:1px solid #2a2a2c;box-sizing:border-box;position:relative;
  font:12px/${BAR}px "Segoe UI",system-ui,sans-serif;color:#8e8e93;text-align:center}
.dots{position:absolute;left:12px;top:0;height:${BAR}px;display:flex;gap:8px;align-items:center}
.dots i{width:12px;height:12px;border-radius:50%;display:block}
.t{font:15px/18px "Cascadia Mono","Cascadia Code",Consolas,monospace;white-space:pre}
.r{height:18px;overflow:hidden}.w{display:inline-block;width:2ch}
.b{display:inline-block;width:1ch;height:18px;vertical-align:top}
</style>${batch.map((f) => `<div class="f">${bar}<div class="p"><div class="t">${f.html}</div></div></div>`).join('')}`,
  );
  await screenshot(htmlPath, pngPath, batch.length * frameH);
  for (let j = 0; j < batch.length; j++) {
    pngs.push(
      await sharp(pngPath)
        .extract({ left: 0, top: Math.round(j * frameH * SCALE), width: Math.round(width * SCALE), height: Math.round(frameH * SCALE) })
        .png()
        .toBuffer(),
    );
  }
  process.stdout.write(`[gif] rendered ${Math.min(i + BATCH, frames.length)}/${frames.length}\r`);
}
console.log();

if (outPath.endsWith('.png')) {
  writeFileSync(outPath, pngs[0]);
  rmSync(work, { recursive: true, force: true });
  console.log(`[gif] -> ${outPath}`);
  process.exit(0);
}
const format = outPath.endsWith('.webp') ? 'webp' : 'gif';
const pipeline = sharp(pngs, { join: { animated: true } });
const delays = frames.map((f) => Math.max(20, Math.round(f.ms)));
if (format === 'gif') {
  await pipeline
    .gif({ delay: delays, loop: 0, colours: COLOURS, effort: 10, dither: 0, interFrameMaxError: 4 })
    .toFile(outPath);
} else {
  await pipeline.webp({ delay: delays, loop: 0, quality: 90, effort: 6, smartSubsample: true }).toFile(outPath);
}
// The last frame, as a still for a poster or a fallback.
writeFileSync(outPath.replace(/\.(gif|webp)$/, '.last.png'), pngs.at(-1));
rmSync(work, { recursive: true, force: true });
console.log(`[gif] -> ${outPath}`);
