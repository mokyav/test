import { World } from "../src/client/world";
import { moveBody, raycast, type Body } from "../src/client/physics";
import { B } from "../shared/blocks";
let fail = 0;
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.log("FAIL", m); } else console.log("ok  ", m); };
const w = new World(1);
for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) { const c = w.ensureChunk(cx, cz); c.data.fill(0); for (let i = 0; i < 256; i++) c.data[i] = B.STONE; } // y=0 の床のみ
const body: Body = { x: 0.5, y: 10, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false };
for (let i = 0; i < 200; i++) { body.vy -= 28 * 0.016; moveBody(w, body, 0.016); }
ok(Math.abs(body.y - 1) < 0.01 && body.onGround, `着地 y=${body.y.toFixed(3)}`);
w.setBlock(3, 1, 0, B.STONE); w.setBlock(3, 2, 0, B.STONE);
body.x = 0.5; body.z = 0.5; body.vx = 6;
for (let i = 0; i < 100; i++) moveBody(w, body, 0.016);
ok(body.x < 3 - 0.3 + 0.001, `壁で停止 x=${body.x.toFixed(3)}`);
const h = raycast(w, 0.5, 2.6, 0.5, 1, 0, 0, 6);
ok(!!h && h.x === 3 && h.nx === -1 && h.y === 2, `レイキャスト ${JSON.stringify(h)}`);
const h2 = raycast(w, 0.5, 5, 0.5, 0, -1, 0, 6);
ok(!!h2 && h2.y === 0 && h2.ny === 1, "下向きレイ");
// 高速落下でもすり抜けない
body.y = 50; body.vy = -300; body.x = 8; body.z = 8; body.vx = 0;
moveBody(w, body, 0.1);
ok(body.y >= 1 - 0.001, `高速落下でもすり抜けない y=${body.y.toFixed(2)}`);
console.log(fail ? "FAILED" : "ALL PASSED"); process.exit(fail ? 1 : 0);
