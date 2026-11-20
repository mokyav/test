import * as THREE from "three";
import { BLOCKS } from "../../shared/blocks";
import { tileUV } from "./atlas";
import type { World } from "./world";

export const DROP_TTL_MS = 5 * 60 * 1000;
const PICKUP_DELAY = 0.6; // 出現してから回収できるまで(秒)
const PICKUP_RANGE = 1.6; // プレイヤー中心からの距離
const SIZE = 0.3;
const GRAVITY = 22;

interface Drop {
  eid: string;
  b: number;
  mesh: THREE.Mesh;
  x: number;
  y: number;
  z: number;
  vy: number;
  age: number;
  phase: number;
  landed: boolean;
  /** pickup を送信済み(サーバーの返事待ち) */
  claimedAt: number;
  born: number;
}

/** ブロック種別ごとの小さな立方体ジオメトリ(アトラスのタイルに UV を合わせる) */
function makeGeometry(id: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(SIZE, SIZE, SIZE);
  const def = BLOCKS[id];
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  // BoxGeometry の面順: +x, -x, +y, -y, +z, -z(各4頂点)
  const tiles = [def.tiles.side, def.tiles.side, def.tiles.top, def.tiles.bottom, def.tiles.side, def.tiles.side];
  for (let f = 0; f < 6; f++) {
    const [u0, v0, u1, v1] = tileUV(tiles[f]);
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, u0 + uv.getX(k) * (u1 - u0), v0 + uv.getY(k) * (v1 - v0));
    }
  }
  uv.needsUpdate = true;
  return g;
}

/** ドロップアイテム(エンティティ)。落下・回転・上下に浮遊し、近づくと回収対象になる。 */
export class DropEntities {
  readonly group = new THREE.Group();
  private map = new Map<string, Drop>();
  private geos = new Map<number, THREE.BoxGeometry>();
  private mat: THREE.MeshBasicMaterial;

  constructor(atlas: HTMLCanvasElement) {
    const tex = new THREE.CanvasTexture(atlas);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    this.mat = new THREE.MeshBasicMaterial({ map: tex, alphaTest: 0.5 });
  }

  get size() { return this.map.size; }
  has(eid: string) { return this.map.has(eid); }
  blockOf(eid: string): number | null { return this.map.get(eid)?.b ?? null; }

  add(eid: string, x: number, y: number, z: number, b: number) {
    if (this.map.has(eid) || b < 1 || b >= BLOCKS.length) return;
    let g = this.geos.get(b);
    if (!g) this.geos.set(b, (g = makeGeometry(b)));
    const mesh = new THREE.Mesh(g, this.mat);
    const d: Drop = {
      eid, b, mesh, x: x + 0.5, y: y + SIZE / 2 + 0.05, z: z + 0.5, vy: 0, age: 0,
      phase: Math.random() * Math.PI * 2, landed: false, claimedAt: 0, born: performance.now(),
    };
    mesh.position.set(d.x, d.y, d.z);
    this.group.add(mesh);
    this.map.set(eid, d);
  }

  remove(eid: string) {
    const d = this.map.get(eid);
    if (!d) return;
    this.group.remove(d.mesh);
    this.map.delete(eid);
  }

  clear() {
    for (const id of Array.from(this.map.keys())) this.remove(id);
  }

  setLight(v: number) { this.mat.color.setScalar(v); }

  /**
   * 毎フレーム更新。プレイヤー(px,py,pz = 足元)に近く回収できるドロップの eid 一覧を返す(無ければ空)。
   * canPickup=false の間は回収しない(クリエイティブ・未接続など)。
   */
  update(dt: number, world: World, px: number, py: number, pz: number, canPickup: boolean): string[] {
    const out: string[] = [];
    const now = performance.now();
    const cy = py + 0.9;
    for (const d of Array.from(this.map.values())) {
      if (now - d.born > DROP_TTL_MS) { this.remove(d.eid); continue; }
      d.age += dt;

      // 落下(未ロードチャンクの上では止まる)
      if (!d.landed) {
        d.vy = Math.max(-30, d.vy - GRAVITY * dt);
        let ny = d.y + d.vy * dt;
        const bx = Math.floor(d.x), bz = Math.floor(d.z);
        const below = Math.floor(ny - SIZE / 2);
        const bid = world.get(bx, below, bz);
        if (bid === -1 || world.isSolid(bx, below, bz) || below < 0) {
          ny = below + 1 + SIZE / 2 + 0.02;
          d.vy = 0;
          d.landed = true;
        }
        d.y = ny;
      } else {
        // 下のブロックが壊されたら再び落ちる / 上にブロックを置かれて埋まったら押し上げる
        const bx = Math.floor(d.x), bz = Math.floor(d.z);
        if (!world.isSolid(bx, Math.floor(d.y - SIZE / 2 - 0.05), bz)) d.landed = false;
        else if (world.isSolid(bx, Math.floor(d.y), bz) && d.y < 62) d.y += 1;
      }

      const bob = d.landed ? Math.sin(d.age * 2.4 + d.phase) * 0.06 + 0.1 : 0;
      d.mesh.position.set(d.x, d.y + bob, d.z);
      d.mesh.rotation.y = d.age * 1.6 + d.phase;

      if (canPickup && d.age >= PICKUP_DELAY && (d.claimedAt === 0 || now - d.claimedAt > 1500)) {
        const dx = d.x - px, dy = d.y - cy, dz = d.z - pz;
        if (dx * dx + dy * dy + dz * dz <= PICKUP_RANGE * PICKUP_RANGE) {
          d.claimedAt = now;
          out.push(d.eid);
        }
      }
    }
    return out;
  }
}
