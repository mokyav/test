import { World } from "../src/client/world";
import { buildChunkMesh } from "../src/client/mesher";
import { generateChunk, heightAt } from "../src/client/worldgen";
import { B, BLOCKS, TILE_KEYS } from "../shared/blocks";
import { isValidSet } from "../shared/validate";
import { localIndex } from "../shared/coords";

let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.log("FAIL", m); } else console.log("ok  ", m); };

// 決定性
const a = generateChunk(12345, 3, -2), b = generateChunk(12345, 3, -2);
ok(a.every((v, i) => v === b[i]), "地形生成は決定的");
ok(heightAt(1, 0, 0) === heightAt(1, 0, 0), "heightAt 決定的");

const w = new World(777);
for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) w.ensureChunk(cx, cz);
const tileUV = (k: string) => { const i = TILE_KEYS.indexOf(k); return [i / 32, 0, (i + 1) / 32, 1] as [number, number, number, number]; };
const c = w.getChunk(0, 0)!;
const t0 = performance.now();
const m = buildChunkMesh(w, c, tileUV);
console.log("mesh ms", (performance.now() - t0).toFixed(1), "verts", m.solid?.vertexCount, "liquid", m.liquid?.vertexCount);
ok(!!m.solid && m.solid.vertexCount > 0, "メッシュ生成");
ok(m.solid!.indices.length / 6 === m.solid!.vertexCount / 4, "面数一致");
let maxIdx = 0; for (const i of m.solid!.indices) maxIdx = Math.max(maxIdx, i);
ok(maxIdx < m.solid!.vertexCount, "インデックス範囲");

// 内部の完全に埋まったブロックは面を持たない: 全部石のチャンクを作る
const w2 = new World(1);
const cc = w2.ensureChunk(0, 0); cc.data.fill(B.STONE); cc.maxY = 63;
for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) { const n = w2.ensureChunk(dx, dz); n.data.fill(B.STONE); }
const mm = buildChunkMesh(w2, cc, tileUV);
ok(mm.solid!.vertexCount / 4 === 256 /*top*/ + 0, `埋まったチャンクは上面のみ (${mm.solid!.vertexCount / 4}面)`);

// 編集
const dirty: number[] = [];
w.onChunkDirty = (ch) => dirty.push(ch.cx * 10 + ch.cz);
const h = heightAt(777, 0, 0);
ok(w.setBlock(0, h, 0, B.AIR), "破壊");
ok(w.get(0, h, 0) === B.AIR, "破壊反映");
ok(dirty.length >= 3, `境界(0,0)は隣チャンクも再メッシュ (${dirty.length})`);
w.setBlock(5, 40, 5, B.BRICK);
ok(w.get(5, 40, 5) === B.BRICK, "設置");
const exp = w.exportEdits();
ok(exp.length === 8, "差分エクスポート");
// アンロード→再ロードで差分が復元される
w.unloadChunk(0, 0); w.ensureChunk(0, 0);
ok(w.get(5, 40, 5) === B.BRICK && w.get(0, h, 0) === B.AIR, "再生成時に差分適用");
// 別ワールドへインポート
const w3 = new World(777); w3.ensureChunk(0, 0); w3.importEdits(exp);
ok(w3.get(5, 40, 5) === B.BRICK, "importEdits");
// 負座標
w.setBlock(-1, 30, -1, B.LAMP);
ok(w.get(-1, 30, -1) === B.LAMP, "負座標の編集");
ok(w.exportEdits().some((v, i, arr) => i % 4 === 0 && v === -1 && arr[i + 2] === -1), "負座標エクスポート");

// 検証
ok(isValidSet(1, 10, 1, B.STONE) && !isValidSet(1, 0, 1, B.STONE) && !isValidSet(1, 10, 1, B.BEDROCK) && !isValidSet(1.5, 10, 1, 1) && !isValidSet(1, 10, 1, 99), "isValidSet");
ok(localIndex(-1, 3, -1) === (3 * 16 + 15) * 16 + 15, "localIndex 負座標");
ok(BLOCKS.length === 21, "ブロック定義");
console.log(fail ? `${fail} FAILED` : "ALL PASSED");
process.exit(fail ? 1 : 0);
