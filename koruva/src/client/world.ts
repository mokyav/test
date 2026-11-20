import { B, BLOCKS } from "../../shared/blocks";
import { CHUNK_SIZE, CHUNK_VOLUME, WORLD_HEIGHT } from "../../shared/constants";
import { localCoord, localIndex, chunkCoord } from "../../shared/coords";
import { generateChunk } from "./worldgen";

export interface Chunk {
  cx: number;
  cz: number;
  data: Uint8Array;
  dirty: boolean;
  /** 空でない最大Y(メッシュ生成の走査範囲を狭める) */
  maxY: number;
}

export const chunkKey = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);

export class World {
  seed: number;
  chunks = new Map<number, Chunk>();
  /** 編集差分: chunkKey -> (localIndex -> blockId) */
  edits = new Map<number, Map<number, number>>();
  /** 変更があったチャンク(再メッシュ対象) */
  onChunkDirty: ((c: Chunk) => void) | null = null;

  constructor(seed: number) {
    this.seed = seed;
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  ensureChunk(cx: number, cz: number): Chunk {
    const key = chunkKey(cx, cz);
    let c = this.chunks.get(key);
    if (c) return c;
    const data = generateChunk(this.seed, cx, cz);
    const ed = this.edits.get(key);
    if (ed) for (const [i, b] of ed) data[i] = b;
    c = { cx, cz, data, dirty: true, maxY: 0 };
    c.maxY = computeMaxY(data);
    this.chunks.set(key, c);
    return c;
  }

  unloadChunk(cx: number, cz: number) {
    this.chunks.delete(chunkKey(cx, cz));
  }

  /** 範囲外Yは岩盤/空気、未ロードチャンクは -1 */
  get(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (y >= WORLD_HEIGHT) return B.AIR;
    const c = this.chunks.get(chunkKey(chunkCoord(x), chunkCoord(z)));
    if (!c) return -1;
    return c.data[localIndex(x, y, z)];
  }

  isSolid(x: number, y: number, z: number): boolean {
    const b = this.get(x, y, z);
    return b === -1 ? true : BLOCKS[b].solid;
  }

  hasChunkAt(x: number, z: number): boolean {
    return this.chunks.has(chunkKey(chunkCoord(x), chunkCoord(z)));
  }

  /** ブロックを変更し差分を記録。変更があれば true */
  setBlock(x: number, y: number, z: number, b: number): boolean {
    if (y < 1 || y >= WORLD_HEIGHT) return false;
    const cx = chunkCoord(x), cz = chunkCoord(z);
    const key = chunkKey(cx, cz);
    const i = localIndex(x, y, z);
    let ed = this.edits.get(key);
    if (!ed) this.edits.set(key, (ed = new Map()));
    const c = this.chunks.get(key);
    if (c && c.data[i] === b) {
      ed.set(i, b);
      return false;
    }
    ed.set(i, b);
    if (!c) return true;
    c.data[i] = b;
    if (b !== 0 && y > c.maxY) c.maxY = y;
    const lx = localCoord(x), lz = localCoord(z);
    const xs = [0], zs = [0];
    if (lx === 0) xs.push(-1);
    if (lx === CHUNK_SIZE - 1) xs.push(1);
    if (lz === 0) zs.push(-1);
    if (lz === CHUNK_SIZE - 1) zs.push(1);
    for (const dx of xs) {
      for (const dz of zs) {
        const n = this.chunks.get(chunkKey(cx + dx, cz + dz));
        if (n) {
          n.dirty = true;
          this.onChunkDirty?.(n);
        }
      }
    }
    return true;
  }

  /** 保存用: [x,y,z,b,...] */
  exportEdits(): number[] {
    const out: number[] = [];
    for (const [key, ed] of this.edits) {
      const cx = Math.floor(key / 65536) - 32768;
      const cz = (key % 65536) - 32768;
      for (const [i, b] of ed) {
        out.push(cx * CHUNK_SIZE + (i & 15), i >> 8, cz * CHUNK_SIZE + ((i >> 4) & 15), b);
      }
    }
    return out;
  }

  importEdits(list: ArrayLike<number>) {
    for (let i = 0; i + 3 < list.length; i += 4) {
      this.setBlock(list[i], list[i + 1], list[i + 2], list[i + 3]);
    }
  }

  /** 全チャンクを破棄して差分も消す(ロード時のリセット用) */
  reset(seed: number) {
    this.seed = seed;
    this.chunks.clear();
    this.edits.clear();
  }
}

function computeMaxY(data: Uint8Array): number {
  for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
    const base = y * CHUNK_SIZE * CHUNK_SIZE;
    for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) if (data[base + i] !== 0) return y;
  }
  return 0;
}

export { CHUNK_VOLUME };
