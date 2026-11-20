import { BLOCKS } from "../../shared/blocks";
import type { World } from "./world";

export const PLAYER_W = 0.6;
export const PLAYER_H = 1.8;
export const EYE_H = 1.62;
const HW = PLAYER_W / 2;
const EPS = 1e-4;

export interface Body {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
}

export function collides(world: World, x: number, y: number, z: number): boolean {
  const x0 = Math.floor(x - HW), x1 = Math.floor(x + HW);
  const y0 = Math.floor(y), y1 = Math.floor(y + PLAYER_H);
  const z0 = Math.floor(z - HW), z1 = Math.floor(z + HW);
  for (let by = y0; by <= y1; by++)
    for (let bz = z0; bz <= z1; bz++)
      for (let bx = x0; bx <= x1; bx++) if (world.isSolid(bx, by, bz)) return true;
  return false;
}

/** 軸ごとに分割して移動。ブロックにめり込んだら押し戻す。 */
export function moveBody(world: World, b: Body, dt: number) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.vx), Math.abs(b.vy), Math.abs(b.vz)) * dt / 0.3));
  const sdt = dt / steps;
  for (let s = 0; s < steps; s++) {
    moveAxis(world, b, 0, b.vx * sdt);
    moveAxis(world, b, 2, b.vz * sdt);
    b.onGround = false;
    moveAxis(world, b, 1, b.vy * sdt);
  }
}

function moveAxis(world: World, b: Body, axis: 0 | 1 | 2, d: number) {
  if (d === 0) return;
  if (axis === 0) b.x += d; else if (axis === 1) b.y += d; else b.z += d;
  if (!collides(world, b.x, b.y, b.z)) return;
  if (axis === 0) {
    b.x = d > 0 ? Math.floor(b.x + HW) - HW - EPS : Math.floor(b.x - HW) + 1 + HW + EPS;
    b.vx = 0;
  } else if (axis === 2) {
    b.z = d > 0 ? Math.floor(b.z + HW) - HW - EPS : Math.floor(b.z - HW) + 1 + HW + EPS;
    b.vz = 0;
  } else {
    if (d > 0) b.y = Math.floor(b.y + PLAYER_H) - PLAYER_H - EPS;
    else { b.y = Math.floor(b.y) + 1 + EPS; b.onGround = true; }
    b.vy = 0;
  }
}

export function inLiquid(world: World, x: number, y: number, z: number): boolean {
  const id = world.get(Math.floor(x), Math.floor(y), Math.floor(z));
  return id > 0 && BLOCKS[id].render === "liquid";
}

export interface RayHit {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
}

/** Amanatides-Woo によるボクセルレイキャスト。水は無視。 */
export function raycast(
  world: World, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number,
): RayHit | null {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tx = dx !== 0 ? (sx > 0 ? x + 1 - ox : ox - x) * tdx : Infinity;
  let ty = dy !== 0 ? (sy > 0 ? y + 1 - oy : oy - y) * tdy : Infinity;
  let tz = dz !== 0 ? (sz > 0 ? z + 1 - oz : oz - z) * tdz : Infinity;
  let nx = 0, ny = 0, nz = 0, t = 0;
  while (t <= maxDist) {
    const id = world.get(x, y, z);
    if (id === -1) return null;
    if (id > 0 && BLOCKS[id].render !== "liquid") return { x, y, z, nx, ny, nz };
    if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; nx = -sx; ny = 0; nz = 0; }
    else if (ty < tz) { y += sy; t = ty; ty += tdy; nx = 0; ny = -sy; nz = 0; }
    else { z += sz; t = tz; tz += tdz; nx = 0; ny = 0; nz = -sz; }
  }
  return null;
}
