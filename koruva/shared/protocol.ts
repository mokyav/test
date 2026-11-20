export interface Skin {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
}
export type Vec3 = [number, number, number];
export type Rot = [number, number];

export const DEFAULT_SKIN: Skin = { skin: "#e8b48a", hair: "#4a3022", shirt: "#3b82c4", pants: "#2f3a63" };

export type GameMode = "survival" | "creative";

export interface PlayerInfo {
  id: string;
  name: string;
  skin: Skin;
  p: Vec3;
  r: Rot;
  /** ルームを作成したホストか(表示用) */
  host?: boolean;
}

export interface BanEntry {
  bid: string;
  name: string;
}

export type ClientMsg =
  | { t: "hello"; name: string; skin: Skin; p?: Vec3; r?: Rot; cid?: string; hostToken?: string }
  | { t: "pos"; p: Vec3; r: Rot }
  | { t: "set"; x: number; y: number; z: number; b: number; d?: number } // d: 壊したブロックのドロップ(サバイバルのみ有効)
  | { t: "pickup"; eid: string }
  | { t: "chat"; text: string } // "/" で始まる場合はコマンドとしてサーバーが処理
  // ---- ホスト専用(サーバー側で権限を検証) ----
  | { t: "kick"; id: string }
  | { t: "ban"; id: string }
  | { t: "unban"; bid: string }
  | { t: "bans" };

export type ServerMsg =
  | { t: "init"; id: string; code: string; seed: number; now: number; t0: number; players: PlayerInfo[]; editCount: number; mode: GameMode; host: boolean; drops?: { eid: string; x: number; y: number; z: number; b: number }[] }
  | { t: "edits"; list: number[]; done: boolean } // [x,y,z,b, x,y,z,b, ...]
  | { t: "join"; player: PlayerInfo }
  | { t: "leave"; id: string; name: string }
  | { t: "pos"; id: string; p: Vec3; r: Rot }
  | { t: "set"; x: number; y: number; z: number; b: number; id: string }
  | { t: "chat"; id: string; name: string; text: string }
  | { t: "reject"; x: number; y: number; z: number }
  | { t: "drop"; eid: string; x: number; y: number; z: number; b: number }
  | { t: "gone"; eid: string; by: string } // by = 回収したプレイヤーID(期限切れ等は空)
  | { t: "mode"; mode: GameMode }
  | { t: "kicked"; reason: string }
  | { t: "bans"; list: BanEntry[] }
  | { t: "error"; message: string };
