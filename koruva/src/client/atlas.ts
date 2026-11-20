// 完全オリジナルの手続き生成テクスチャ。外部画像・他ゲームのアセットは一切使用しない。
import { TILE_KEYS } from "../../shared/blocks";

export const TILE = 16;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = Math.ceil(TILE_KEYS.length / ATLAS_COLS);

function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type RGB = [number, number, number];
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

function noiseTile(ctx: CanvasRenderingContext2D, ox: number, oy: number, key: string, base: RGB, vary: number) {
  const r = rng(key);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const d = (r() - 0.5) * vary;
      ctx.fillStyle = `rgb(${clamp(base[0] + d)},${clamp(base[1] + d)},${clamp(base[2] + d)})`;
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}
function px(ctx: CanvasRenderingContext2D, ox: number, oy: number, x: number, y: number, c: string) {
  ctx.fillStyle = c;
  ctx.fillRect(ox + x, oy + y, 1, 1);
}

function drawTile(ctx: CanvasRenderingContext2D, key: string, ox: number, oy: number) {
  const r = rng(key + "x");
  switch (key) {
    case "grass_top": noiseTile(ctx, ox, oy, key, [96, 160, 62], 36); break;
    case "grass_side":
      noiseTile(ctx, ox, oy, "dirt", [121, 85, 58], 30);
      for (let x = 0; x < TILE; x++) {
        const h = 3 + Math.floor(r() * 3);
        for (let y = 0; y < h; y++) {
          const d = (r() - 0.5) * 30;
          px(ctx, ox, oy, x, y, `rgb(${clamp(96 + d)},${clamp(160 + d)},${clamp(62 + d)})`);
        }
      }
      break;
    case "dirt": noiseTile(ctx, ox, oy, key, [121, 85, 58], 30); break;
    case "stone": noiseTile(ctx, ox, oy, key, [125, 125, 128], 28); break;
    case "sand": noiseTile(ctx, ox, oy, key, [219, 205, 148], 20); break;
    case "log_side":
      for (let x = 0; x < TILE; x++) {
        const stripe = (x % 4 === 0 ? -18 : 0) + (r() - 0.5) * 14;
        for (let y = 0; y < TILE; y++) px(ctx, ox, oy, x, y, `rgb(${clamp(102 + stripe)},${clamp(77 + stripe)},${clamp(46 + stripe)})`);
      }
      break;
    case "log_top":
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        const ring = Math.floor(d) % 3 === 0 ? -16 : 0;
        const edge = d > 6.5 ? -30 : 0;
        const v = ring + edge + (r() - 0.5) * 10;
        px(ctx, ox, oy, x, y, `rgb(${clamp(170 + v)},${clamp(135 + v)},${clamp(84 + v)})`);
      }
      break;
    case "leaves":
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        if (r() < 0.16) { ctx.clearRect(ox + x, oy + y, 1, 1); continue; }
        const d = (r() - 0.5) * 50;
        px(ctx, ox, oy, x, y, `rgb(${clamp(52 + d)},${clamp(122 + d)},${clamp(48 + d)})`);
      }
      break;
    case "planks":
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const seam = y % 4 === 3 ? -28 : 0;
        const d = seam + (r() - 0.5) * 14;
        px(ctx, ox, oy, x, y, `rgb(${clamp(176 + d)},${clamp(138 + d)},${clamp(84 + d)})`);
      }
      break;
    case "glass":
      ctx.clearRect(ox, oy, TILE, TILE);
      for (let i = 0; i < TILE; i++) {
        for (const [x, y] of [[i, 0], [i, TILE - 1], [0, i], [TILE - 1, i]]) px(ctx, ox, oy, x, y, "rgb(190,225,235)");
      }
      for (let i = 3; i < 8; i++) px(ctx, ox, oy, i, 11 - i + 3, "rgba(255,255,255,0.8)");
      ctx.fillStyle = "rgba(180,220,240,0.18)";
      ctx.fillRect(ox + 1, oy + 1, TILE - 2, TILE - 2);
      break;
    case "cobble":
      noiseTile(ctx, ox, oy, key, [118, 118, 120], 20);
      for (let i = 0; i < 14; i++) {
        const cx = Math.floor(r() * 14) + 1, cy = Math.floor(r() * 14) + 1;
        const v = (r() - 0.5) * 70;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) px(ctx, ox, oy, (cx + dx) % TILE, (cy + dy) % TILE, `rgb(${clamp(125 + v)},${clamp(125 + v)},${clamp(128 + v)})`);
      }
      for (let i = 0; i < 22; i++) px(ctx, ox, oy, Math.floor(r() * TILE), Math.floor(r() * TILE), "rgb(70,70,74)");
      break;
    case "brick":
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const row = Math.floor(y / 4);
        const off = row % 2 ? 4 : 0;
        const mortar = y % 4 === 3 || (x + off) % 8 === 7;
        const d = (r() - 0.5) * 20;
        px(ctx, ox, oy, x, y, mortar ? `rgb(${clamp(190 + d)},${clamp(184 + d)},${clamp(172 + d)})` : `rgb(${clamp(158 + d)},${clamp(72 + d)},${clamp(58 + d)})`);
      }
      break;
    case "snow": noiseTile(ctx, ox, oy, key, [244, 248, 252], 10); break;
    case "water": noiseTile(ctx, ox, oy, key, [52, 110, 200], 22); break;
    case "lamp":
      for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
        const frame = x < 2 || y < 2 || x > 13 || y > 13;
        const cross = x === 7 || x === 8 || y === 7 || y === 8;
        const d = (r() - 0.5) * 14;
        if (frame) px(ctx, ox, oy, x, y, `rgb(${clamp(150 + d)},${clamp(110 + d)},${clamp(60 + d)})`);
        else px(ctx, ox, oy, x, y, cross ? `rgb(255,${clamp(226 + d)},150)` : `rgb(255,${clamp(244 + d)},${clamp(196 + d)})`);
      }
      break;
    case "bedrock": noiseTile(ctx, ox, oy, key, [50, 50, 54], 55); break;
    case "gravel": noiseTile(ctx, ox, oy, key, [132, 126, 122], 70); break;
    case "ore":
      noiseTile(ctx, ox, oy, "stone", [125, 125, 128], 28);
      for (let i = 0; i < 9; i++) {
        const cx = Math.floor(r() * 14) + 1, cy = Math.floor(r() * 14) + 1;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1]]) px(ctx, ox, oy, cx + dx, cy + dy, i % 2 ? "rgb(224,160,70)" : "rgb(240,200,110)");
      }
      break;
    case "red": noiseTile(ctx, ox, oy, key, [196, 56, 52], 14); break;
    case "blue": noiseTile(ctx, ox, oy, key, [60, 96, 200], 14); break;
    case "yellow": noiseTile(ctx, ox, oy, key, [236, 200, 60], 14); break;
    case "white": noiseTile(ctx, ox, oy, key, [236, 236, 240], 10); break;
    default: noiseTile(ctx, ox, oy, key, [255, 0, 255], 0);
  }
}

export function createAtlasCanvas(): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = ATLAS_COLS * TILE;
  cv.height = ATLAS_ROWS * TILE;
  const ctx = cv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  TILE_KEYS.forEach((k, i) => drawTile(ctx, k, (i % ATLAS_COLS) * TILE, Math.floor(i / ATLAS_COLS) * TILE));
  return cv;
}

export function tileIndex(key: string): number {
  return TILE_KEYS.indexOf(key);
}

/** u0,v0,u1,v1 (v は上が1: three.js の flipY 前提) */
export function tileUV(key: string): [number, number, number, number] {
  const i = tileIndex(key);
  const c = i % ATLAS_COLS, r = Math.floor(i / ATLAS_COLS);
  return [c / ATLAS_COLS, 1 - (r + 1) / ATLAS_ROWS, (c + 1) / ATLAS_COLS, 1 - r / ATLAS_ROWS];
}
