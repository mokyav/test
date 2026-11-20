// シードから決定的に地形を生成する(サーバーとクライアントで同じ結果になる純粋関数)。
import { B } from "../../shared/blocks";
import { CHUNK_SIZE, CHUNK_VOLUME, SEA_LEVEL, WORLD_HEIGHT } from "../../shared/constants";

function hash2(seed: number, x: number, z: number): number {
  let h = (seed | 0) ^ Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = Math.imul(h ^ (h >>> 16), 2246822519);
  return (h ^ (h >>> 15)) >>> 0;
}
export function rand2(seed: number, x: number, z: number): number {
  return hash2(seed, x, z) / 4294967296;
}
const fade = (t: number) => t * t * (3 - 2 * t);

function valueNoise(seed: number, x: number, z: number): number {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = fade(x - x0), fz = fade(z - z0);
  const a = rand2(seed, x0, z0), b = rand2(seed, x0 + 1, z0);
  const c = rand2(seed, x0, z0 + 1), d = rand2(seed, x0 + 1, z0 + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
function fbm(seed: number, x: number, z: number, oct: number): number {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += valueNoise(seed + i * 131, x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

export function heightAt(seed: number, x: number, z: number): number {
  const cont = Math.min(1, Math.max(0, (fbm(seed, x / 160, z / 160, 3) - 0.5) * 1.9 + 0.5));
  const hills = fbm(seed + 101, x / 44, z / 44, 4);
  let h = 12 + cont * 15 + hills * 11;
  const m = Math.max(0, cont - 0.6) / 0.4;
  h += m * m * 24;
  return Math.max(3, Math.min(WORLD_HEIGHT - 8, Math.floor(h)));
}

/** 木があれば幹の高さ、なければ0 */
export function treeAt(seed: number, x: number, z: number, h: number): number {
  if (h <= SEA_LEVEL + 1 || h >= 44) return 0;
  const r = rand2(seed + 999, x, z);
  if (r >= 0.012) return 0;
  return 4 + (hash2(seed + 7, x, z) % 3);
}

const idx = (lx: number, y: number, lz: number) => (y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;

export function generateChunk(seed: number, cx: number, cz: number): Uint8Array {
  const data = new Uint8Array(CHUNK_VOLUME);
  const ox = cx * CHUNK_SIZE, oz = cz * CHUNK_SIZE;
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = ox + lx, wz = oz + lz;
      const h = heightAt(seed, wx, wz);
      for (let y = 0; y <= h; y++) {
        let b: number = B.STONE;
        if (y === 0) b = B.BEDROCK;
        else if (y === h) b = h >= 46 ? B.SNOW : h <= SEA_LEVEL + 1 ? B.SAND : B.GRASS;
        else if (y >= h - 3) b = h <= SEA_LEVEL + 1 ? B.SAND : h >= 46 ? B.STONE : B.DIRT;
        else if (y < h - 3 && y > 1 && rand2(seed + 5, wx + y * 7919, wz - y * 104729) < 0.012) b = B.ORE;
        else if (y < h - 4 && y > 1 && rand2(seed + 6, wx - y * 3571, wz + y * 6803) < 0.006) b = B.GRAVEL;
        data[idx(lx, y, lz)] = b;
      }
      for (let y = h + 1; y <= SEA_LEVEL; y++) data[idx(lx, y, lz)] = B.WATER;
    }
  }
  // 木(隣接チャンクにはみ出す葉も含めて決定的に配置)
  for (let tz = oz - 2; tz < oz + CHUNK_SIZE + 2; tz++) {
    for (let tx = ox - 2; tx < ox + CHUNK_SIZE + 2; tx++) {
      const h = heightAt(seed, tx, tz);
      const th = treeAt(seed, tx, tz, h);
      if (!th) continue;
      for (let i = 1; i <= th; i++) put(data, ox, oz, tx, h + i, tz, B.LOG, true);
      for (let dy = th - 2; dy <= th + 1; dy++) {
        const r = dy >= th ? 1 : 2;
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (r === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
            put(data, ox, oz, tx + dx, h + dy + 1, tz + dz, B.LEAVES, false);
          }
        }
      }
    }
  }
  return data;
}

function put(data: Uint8Array, ox: number, oz: number, x: number, y: number, z: number, b: number, force: boolean) {
  const lx = x - ox, lz = z - oz;
  if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 1 || y >= WORLD_HEIGHT) return;
  const i = idx(lx, y, lz);
  if (force || data[i] === B.AIR) data[i] = b;
}
