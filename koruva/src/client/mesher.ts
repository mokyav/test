// チャンク単位のメッシュ生成: 隠れ面カリング + 頂点AO。three.js に依存しない純粋関数。
import { BLOCKS } from "../../shared/blocks";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../../shared/constants";
import type { Chunk, World } from "./world";

export interface MeshData {
  positions: Float32Array;
  uvs: Float32Array;
  /** rgba: rgb=明るさ(面の向き×AO), a=自己発光 */
  colors: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
}

export interface ChunkMeshes {
  solid: MeshData | null;
  liquid: MeshData | null;
}

export type TileUV = (tileKey: string) => [number, number, number, number]; // u0,v0,u1,v1

interface FaceDef {
  n: [number, number, number];
  a: [number, number, number];
  b: [number, number, number];
  swap: boolean;
  shade: number;
  which: "top" | "side" | "bottom";
}

const FACES: FaceDef[] = [
  { n: [1, 0, 0], a: [0, 1, 0], b: [0, 0, 1], swap: true, shade: 0.82, which: "side" },
  { n: [-1, 0, 0], a: [0, 0, 1], b: [0, 1, 0], swap: false, shade: 0.82, which: "side" },
  { n: [0, 1, 0], a: [0, 0, 1], b: [1, 0, 0], swap: false, shade: 1.0, which: "top" },
  { n: [0, -1, 0], a: [1, 0, 0], b: [0, 0, 1], swap: false, shade: 0.5, which: "bottom" },
  { n: [0, 0, 1], a: [1, 0, 0], b: [0, 1, 0], swap: false, shade: 0.68, which: "side" },
  { n: [0, 0, -1], a: [0, 1, 0], b: [1, 0, 0], swap: true, shade: 0.68, which: "side" },
];
const CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const AO_LEVEL = [0.5, 0.68, 0.84, 1.0];

class Builder {
  pos: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  n = 0;
  finish(): MeshData | null {
    if (this.n === 0) return null;
    return {
      positions: new Float32Array(this.pos),
      uvs: new Float32Array(this.uv),
      colors: new Float32Array(this.col),
      indices: new Uint32Array(this.idx),
      vertexCount: this.n,
    };
  }
}

const UV_PAD = 0.0005;

export function buildChunkMesh(world: World, chunk: Chunk, tileUV: TileUV): ChunkMeshes {
  const solid = new Builder();
  const liquid = new Builder();
  const ox = chunk.cx * CHUNK_SIZE, oz = chunk.cz * CHUNK_SIZE;
  const data = chunk.data;
  const topY = Math.min(WORLD_HEIGHT - 1, chunk.maxY);

  // 未ロードの隣(-1)は不透明扱いにして境界の無駄な面を作らない(ロード後に隣が再メッシュされる)
  const opaqueAt = (x: number, y: number, z: number): boolean => {
    const b = world.get(x, y, z);
    return b === -1 ? true : BLOCKS[b].render === "opaque";
  };

  for (let y = 0; y <= topY; y++) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const id = data[(y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx];
        if (id === 0) continue;
        const def = BLOCKS[id];
        const x = ox + lx, z = oz + lz;
        const target = def.render === "liquid" ? liquid : solid;

        for (const f of FACES) {
          const nx = x + f.n[0], ny = y + f.n[1], nz = z + f.n[2];
          const nid = world.get(nx, ny, nz);
          if (nid === -1) continue;
          if (nid !== 0) {
            const nd = BLOCKS[nid];
            if (nd.render === "opaque") continue;
            if (nid === id && def.cullSame) continue;
            if (def.render === "liquid" && nd.render === "liquid") continue;
          }
          const tile = def.tiles[f.which];
          const [u0, v0, u1, v1] = tileUV(tile);
          const base = target.n;
          const ao: number[] = [];
          for (let q = 0; q < 4; q++) {
            const [sa, sb] = CORNERS[q];
            const px = lx + 0.5 + 0.5 * (f.n[0] + sa * f.a[0] + sb * f.b[0]);
            const py = y + 0.5 + 0.5 * (f.n[1] + sa * f.a[1] + sb * f.b[1]);
            const pz = lz + 0.5 + 0.5 * (f.n[2] + sa * f.a[2] + sb * f.b[2]);
            target.pos.push(px, py, pz);

            let level = 3;
            if (!def.emissive && def.render !== "liquid") {
              const s1 = opaqueAt(nx + sa * f.a[0], ny + sa * f.a[1], nz + sa * f.a[2]) ? 1 : 0;
              const s2 = opaqueAt(nx + sb * f.b[0], ny + sb * f.b[1], nz + sb * f.b[2]) ? 1 : 0;
              const cr = opaqueAt(
                nx + sa * f.a[0] + sb * f.b[0], ny + sa * f.a[1] + sb * f.b[1], nz + sa * f.a[2] + sb * f.b[2],
              ) ? 1 : 0;
              level = s1 && s2 ? 0 : 3 - (s1 + s2 + cr);
            }
            ao.push(level);
            const sh = def.emissive ? 1 : f.shade * AO_LEVEL[level];
            target.col.push(sh, sh, sh, def.emissive ? 1 : 0);
            const ua = (sa + 1) / 2, ub = (sb + 1) / 2;
            const tu = f.swap ? ub : ua, tv = f.swap ? ua : ub;
            target.uv.push(u0 + UV_PAD + (u1 - u0 - 2 * UV_PAD) * tu, v0 + UV_PAD + (v1 - v0 - 2 * UV_PAD) * tv);
          }
          if (ao[0] + ao[2] >= ao[1] + ao[3]) {
            target.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
          } else {
            target.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
          }
          target.n += 4;
        }
      }
    }
  }
  return { solid: solid.finish(), liquid: liquid.finish() };
}
