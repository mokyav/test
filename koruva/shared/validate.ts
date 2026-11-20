import { BLOCK_COUNT, B } from "./blocks";
import { MAX_COORD, WORLD_HEIGHT } from "./constants";
import { DEFAULT_SKIN, type GameMode, type Rot, type Skin, type Vec3 } from "./protocol";

const HEX = /^#[0-9a-fA-F]{6}$/;

/** プレイヤー名: 英数字(a-z A-Z 0-9)とアンダースコアのみ、1〜16文字。空白・記号・日本語は不可。 */
export const NAME_MAX = 16;
export const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
export const NAME_RULE = "名前は半角英数字と _ のみ、1〜16文字で入力してください";
/** 有効な名前ならそのまま、無効なら null を返す(勝手に加工しない) */
export function validateName(v: unknown): string | null {
  return typeof v === "string" && NAME_RE.test(v) ? v : null;
}
/** 名前の重複判定用(大文字小文字を区別しない) */
export const nameKey = (n: string) => n.toLowerCase();
export function sanitizeSkin(v: unknown): Skin {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const pick = (k: keyof Skin) => (typeof o[k] === "string" && HEX.test(o[k] as string) ? (o[k] as string) : DEFAULT_SKIN[k]);
  return { skin: pick("skin"), hair: pick("hair"), shirt: pick("shirt"), pants: pick("pants") };
}
export function sanitizeVec3(v: unknown, fallback: Vec3): Vec3 {
  if (!Array.isArray(v) || v.length !== 3) return fallback;
  const [x, y, z] = v as number[];
  if (![x, y, z].every((n) => typeof n === "number" && Number.isFinite(n))) return fallback;
  return [clamp(x, -MAX_COORD, MAX_COORD), clamp(y, -100, 400), clamp(z, -MAX_COORD, MAX_COORD)];
}
export function sanitizeRot(v: unknown, fallback: Rot): Rot {
  if (!Array.isArray(v) || v.length !== 2) return fallback;
  const [a, b] = v as number[];
  if (![a, b].every((n) => typeof n === "number" && Number.isFinite(n))) return fallback;
  return [clamp(a, -1000, 1000), clamp(b, -2, 2)];
}
export function sanitizeMode(v: unknown): GameMode {
  return v === "survival" ? "survival" : "creative";
}
/** クライアント識別子 / ホストトークン用。英数字とハイフンのみ・最大64文字。 */
export function sanitizeToken(v: unknown): string {
  return typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : "";
}
export function sanitizeChat(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200) : "";
}
/** ブロック設置/破壊の妥当性。b=0 は破壊。 */
export function isValidSet(x: unknown, y: unknown, z: unknown, b: unknown): boolean {
  return (
    Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) && Number.isInteger(b) &&
    Math.abs(x as number) <= MAX_COORD && Math.abs(z as number) <= MAX_COORD &&
    (y as number) >= 1 && (y as number) < WORLD_HEIGHT &&
    (b as number) >= 0 && (b as number) <= BLOCK_COUNT && b !== B.BEDROCK
  );
}
function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}
