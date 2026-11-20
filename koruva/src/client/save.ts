import { DEFAULT_SKIN, type Skin } from "../../shared/protocol";

export interface Profile { name: string; skin: Skin }
export interface PlayerSave {
  pos: [number, number, number];
  yaw: number;
  pitch: number;
  hotbar: number[];
  sel: number;
  /** サバイバル用(古いセーブには無い) */
  counts?: number[];
  health?: number;
  hunger?: number;
}
export interface SoloSave {
  v: 1;
  seed: number;
  edits: number[];
  time: number;
  player: PlayerSave;
  savedAt: number;
}

// 旧名称(voxelcraft:)のセーブも読み込めるようにしておく(書き込みは koruva: のみ)
const PREFIX = "koruva:";
const LEGACY_PREFIX = "voxelcraft:";
const K_PROFILE = PREFIX + "profile";
const K_SOLO = PREFIX + "solo";
const K_ROOM = (code: string) => `${PREFIX}room:${code}`;
const K_HOST = (code: string) => `${PREFIX}host:${code}`;
const K_CID = PREFIX + "cid";
export const K_SETTINGS = PREFIX + "settings";
const K_CHAT = (scope: string) => `${PREFIX}chat:${scope}`;

/** 新キー → 旧キーの順で文字列を読む */
export function getRaw(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? (key.startsWith(PREFIX) ? localStorage.getItem(LEGACY_PREFIX + key.slice(PREFIX.length)) : null);
  } catch { return null; }
}

function read<T>(key: string): T | null {
  try {
    const s = getRaw(key);
    return s ? (JSON.parse(s) as T) : null;
  } catch { return null; }
}
function write(key: string, v: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(v)); return true; } catch { return false; }
}

export const loadProfile = (): Profile => read<Profile>(K_PROFILE) ?? { name: "", skin: { ...DEFAULT_SKIN } };
export const saveProfile = (p: Profile) => write(K_PROFILE, p);
export const loadSolo = () => { const s = read<SoloSave>(K_SOLO); return s && s.v === 1 ? s : null; };
export const saveSolo = (s: SoloSave) => write(K_SOLO, s);
export const deleteSolo = () => { localStorage.removeItem(K_SOLO); localStorage.removeItem(LEGACY_PREFIX + "solo"); };
export const loadRoomPlayer = (code: string) => read<PlayerSave>(K_ROOM(code));
export const saveRoomPlayer = (code: string, p: PlayerSave) => write(K_ROOM(code), p);

/** ルーム作成者だけが持つホストトークン(ルームごとに保存) */
export const loadHostToken = (code: string): string => getRaw(K_HOST(code)) ?? "";
export const saveHostToken = (code: string, token: string) => { try { localStorage.setItem(K_HOST(code), token); } catch { /* ignore */ } };
/** この端末(ブラウザ)の識別子。BAN の判定に使う。 */
export function clientId(): string {
  try {
    let id = getRaw(K_CID);
    if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) { id = crypto.randomUUID(); localStorage.setItem(K_CID, id); }
    return id;
  } catch { return crypto.randomUUID(); }
}

/** チャット履歴(クライアント側のみ保存)。ルームごと(ソロは "solo")に最新30件。 */
export interface ChatLine { text: string; name?: string }
export const CHAT_HISTORY_MAX = 30;
export function loadChat(scope: string): ChatLine[] {
  const v = read<ChatLine[]>(K_CHAT(scope));
  if (!Array.isArray(v)) return [];
  return v
    .filter((l) => l && typeof l.text === "string" && (l.name === undefined || typeof l.name === "string"))
    .slice(-CHAT_HISTORY_MAX);
}
export const saveChat = (scope: string, lines: ChatLine[]) => write(K_CHAT(scope), lines.slice(-CHAT_HISTORY_MAX));
