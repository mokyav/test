import * as THREE from "three";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../../shared/constants";
import { createAtlasCanvas, tileUV } from "./atlas";
import { buildChunkMesh, type MeshData } from "./mesher";
import { chunkKey, type Chunk, type World } from "./world";

const VERT = /* glsl */ `
attribute vec4 color;
varying vec2 vUv;
varying vec4 vCol;
varying float vDist;
void main() {
  vUv = uv;
  vCol = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform vec3 uLight;
uniform vec3 uFog;
uniform float uNear;
uniform float uFar;
uniform float uOpacity;
varying vec2 vUv;
varying vec4 vCol;
varying float vDist;
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < 0.5) discard;
  vec3 c = t.rgb * vCol.rgb * mix(uLight, vec3(1.0), vCol.a);
  float f = smoothstep(uNear, uFar, vDist);
  c = mix(c, uFog, f);
  gl_FragColor = vec4(c, t.a * uOpacity);
}`;

interface Entry {
  solid: THREE.Mesh | null;
  liquid: THREE.Mesh | null;
}

/** チャンクのロード/アンロード、メッシュ生成キュー、描画を管理 */
export class ChunkView {
  readonly group = new THREE.Group();
  readonly uniforms = {
    map: { value: null as THREE.Texture | null },
    uLight: { value: new THREE.Vector3(1, 1, 1) },
    uFog: { value: new THREE.Vector3(0.5, 0.7, 0.95) },
    uNear: { value: 40 },
    uFar: { value: 90 },
    uOpacity: { value: 1 },
  };
  private solidMat: THREE.ShaderMaterial;
  private liquidMat: THREE.ShaderMaterial;
  private entries = new Map<number, Entry>();
  private urgent = new Set<Chunk>();
  renderDistance = 6;
  stats = { chunks: 0, meshed: 0, triangles: 0 };

  constructor(private world: World) {
    const tex = new THREE.CanvasTexture(createAtlasCanvas());
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    this.uniforms.map.value = tex;
    this.solidMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.FrontSide });
    const liquidU = { ...this.uniforms, uOpacity: { value: 0.68 } };
    this.liquidMat = new THREE.ShaderMaterial({
      uniforms: liquidU, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    world.onChunkDirty = (c) => this.urgent.add(c);
  }

  setFog(near: number, far: number) {
    this.uniforms.uNear.value = near;
    this.uniforms.uFar.value = far;
  }

  /** 編集で変更されたチャンクは即時に再メッシュ(ちらつき防止) */
  markUrgent(c: Chunk) {
    this.urgent.add(c);
  }

  /** プレイヤー周辺のチャンクをロードし、メッシュ生成・不要チャンク破棄を行う */
  update(px: number, pz: number, genBudget = 2, meshBudget = 3) {
    const pcx = Math.floor(px / CHUNK_SIZE), pcz = Math.floor(pz / CHUNK_SIZE);
    const rd = this.renderDistance;

    // 1) 生成: 近い順に、描画範囲+1 まで(メッシュ生成には隣接が必要なため)
    let gen = 0;
    for (const [dx, dz] of this.ring(rd + 1)) {
      if (gen >= genBudget) break;
      if (!this.world.getChunk(pcx + dx, pcz + dz)) {
        this.world.ensureChunk(pcx + dx, pcz + dz);
        gen++;
      }
    }

    // 2) 編集由来の即時メッシュ化
    for (const c of this.urgent) {
      if (this.entries.has(chunkKey(c.cx, c.cz)) || c.dirty) this.mesh(c);
    }
    this.urgent.clear();

    // 3) 未メッシュ/ダーティを近い順に処理(4近傍が揃っているもののみ)
    let meshed = 0;
    for (const [dx, dz] of this.ring(rd)) {
      if (meshed >= meshBudget) break;
      const c = this.world.getChunk(pcx + dx, pcz + dz);
      if (!c) continue;
      const has = this.entries.has(chunkKey(c.cx, c.cz));
      if (has && !c.dirty) continue;
      if (!this.hasNeighbors(c)) continue;
      this.mesh(c);
      meshed++;
    }

    // 4) 遠いチャンクを破棄(編集差分は World.edits に残る)
    for (const [key, c] of Array.from(this.world.chunks)) {
      if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > rd + 2) {
        this.dispose(key);
        this.world.unloadChunk(c.cx, c.cz);
      }
    }
    this.stats.chunks = this.world.chunks.size;
  }

  /** 周囲 radius チャンクのうちメッシュ済みの割合(ロード画面用) */
  readyRatio(px: number, pz: number, radius: number): number {
    const pcx = Math.floor(px / CHUNK_SIZE), pcz = Math.floor(pz / CHUNK_SIZE);
    let total = 0, ready = 0;
    for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      total++;
      const c = this.world.getChunk(pcx + dx, pcz + dz);
      if (c && !c.dirty && this.entries.has(chunkKey(c.cx, c.cz))) ready++;
    }
    return ready / total;
  }

  private ringCache = new Map<number, [number, number][]>();
  private ring(r: number): [number, number][] {
    let v = this.ringCache.get(r);
    if (!v) {
      v = [];
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r + r) v.push([dx, dz]);
      v.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
      this.ringCache.set(r, v);
    }
    return v;
  }

  private hasNeighbors(c: Chunk): boolean {
    return !!(
      this.world.getChunk(c.cx + 1, c.cz) && this.world.getChunk(c.cx - 1, c.cz) &&
      this.world.getChunk(c.cx, c.cz + 1) && this.world.getChunk(c.cx, c.cz - 1)
    );
  }

  private mesh(c: Chunk) {
    const key = chunkKey(c.cx, c.cz);
    const res = buildChunkMesh(this.world, c, tileUV);
    c.dirty = false;
    let e = this.entries.get(key);
    if (!e) this.entries.set(key, (e = { solid: null, liquid: null }));
    e.solid = this.swap(e.solid, res.solid, this.solidMat, c, 0);
    e.liquid = this.swap(e.liquid, res.liquid, this.liquidMat, c, 1);
    this.recount();
  }

  private swap(old: THREE.Mesh | null, data: MeshData | null, mat: THREE.Material, c: Chunk, order: number): THREE.Mesh | null {
    if (old) {
      this.group.remove(old);
      old.geometry.dispose();
    }
    if (!data) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(data.uvs, 2));
    g.setAttribute("color", new THREE.BufferAttribute(data.colors, 4));
    g.setIndex(new THREE.BufferAttribute(data.indices, 1));
    // フラスタムカリング用の境界(チャンク全体を包む)
    g.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(CHUNK_SIZE / 2, WORLD_HEIGHT / 2, CHUNK_SIZE / 2),
      Math.hypot(CHUNK_SIZE / 2, WORLD_HEIGHT / 2, CHUNK_SIZE / 2),
    );
    const m = new THREE.Mesh(g, mat);
    m.position.set(c.cx * CHUNK_SIZE, 0, c.cz * CHUNK_SIZE);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.renderOrder = order;
    this.group.add(m);
    return m;
  }

  private dispose(key: number) {
    const e = this.entries.get(key);
    if (!e) return;
    for (const m of [e.solid, e.liquid]) {
      if (m) {
        this.group.remove(m);
        m.geometry.dispose();
      }
    }
    this.entries.delete(key);
  }

  private recount() {
    let tris = 0;
    for (const e of this.entries.values()) {
      for (const m of [e.solid, e.liquid]) if (m) tris += (m.geometry.getIndex()?.count ?? 0) / 3;
    }
    this.stats.meshed = this.entries.size;
    this.stats.triangles = tris;
  }

  clear() {
    for (const key of Array.from(this.entries.keys())) this.dispose(key);
    this.urgent.clear();
  }
}
