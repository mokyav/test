import * as THREE from "three";

export interface SkyState {
  daylight: number; // 0(夜)〜1(昼)
  skyColor: [number, number, number];
  light: [number, number, number];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 時刻 t(0..1): 0=日の出, 0.25=正午, 0.5=日没, 0.75=真夜中 */
export function skyAt(t: number): SkyState {
  const elev = Math.sin(t * Math.PI * 2);
  const daylight = smooth(-0.12, 0.28, elev);
  const night: [number, number, number] = [0.02, 0.03, 0.09];
  const day: [number, number, number] = [0.53, 0.78, 0.95];
  const sky = night.map((n, i) => lerp(n, day[i], daylight)) as [number, number, number];
  const twilight = Math.max(0, 1 - Math.abs(elev) / 0.3) * 0.55;
  sky[0] = lerp(sky[0], 0.95, twilight);
  sky[1] = lerp(sky[1], 0.5, twilight);
  sky[2] = lerp(sky[2], 0.35, twilight);
  const nightL: [number, number, number] = [0.3, 0.34, 0.55];
  const light = nightL.map((n) => lerp(n, 1, daylight)) as [number, number, number];
  return { daylight, skyColor: sky, light };
}

// カメラの far(400) より内側で、描画距離(最大12チャンク≒192)より外側に置く。
// 星は透明マテリアルなので不透明パスの後に描かれる。depthTest を有効にして、
// 手前の地形(深度バッファ)に隠れるようにする(地面を見ているときに星が見えるバグの修正)。
const STAR_R = 300;

export class Sky {
  readonly group = new THREE.Group();
  private sun: THREE.Mesh;
  private moon: THREE.Mesh;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;

  constructor() {
    const mk = (size: number, color: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, fog: false, depthWrite: false, depthTest: false }));
      m.renderOrder = -10;
      m.frustumCulled = false;
      this.group.add(m);
      return m;
    };
    this.sun = mk(26, 0xfff2a8);
    this.moon = mk(16, 0xdfe6f5);
    const pts: number[] = [];
    for (let i = 0; i < 350; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
      pts.push(Math.cos(a) * s * STAR_R, u * STAR_R, Math.sin(a) * s * STAR_R);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    this.starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false, depthTest: true });
    this.stars = new THREE.Points(g, this.starMat);
    this.stars.renderOrder = -11;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);
  }

  update(t: number, cam: THREE.Camera, s: SkyState) {
    this.group.position.copy(cam.position);
    const th = t * Math.PI * 2;
    const dir = new THREE.Vector3(Math.cos(th), Math.sin(th), 0.25).normalize();
    this.sun.position.copy(dir).multiplyScalar(110);
    this.moon.position.copy(dir).multiplyScalar(-110);
    this.sun.lookAt(cam.position);
    this.moon.lookAt(cam.position);
    this.stars.rotation.z = th;
    this.starMat.opacity = Math.max(0, 1 - s.daylight * 1.6);
  }
}
