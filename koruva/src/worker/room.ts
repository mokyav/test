import { DurableObject } from "cloudflare:workers";
import {
  CHUNK_SIZE, CHUNK_VOLUME, MAX_CHUNK_RECORDS, MAX_PLAYERS, NO_EDIT, SERVER_REACH,
} from "../../shared/constants";
import { chunkCoord, localIndex } from "../../shared/coords";
import {
  DEFAULT_SKIN, type BanEntry, type ClientMsg, type GameMode, type PlayerInfo, type Rot, type ServerMsg, type Skin, type Vec3,
} from "../../shared/protocol";
import {
  NAME_RULE, isValidSet, nameKey, sanitizeChat, sanitizeMode, sanitizeRot, sanitizeSkin, sanitizeToken, sanitizeVec3, validateName,
} from "../../shared/validate";
import { BLOCK_COUNT, B } from "../../shared/blocks";
import type { Env } from "./env";

interface Meta {
  code: string;
  seed: number;
  createdAt: number;
  /** 旧ルームには無い → クリエイティブ扱い */
  mode?: GameMode;
  /** ホスト認証用の秘密。旧ルームには無い → ホスト不在 */
  hostToken?: string;
}

interface BanRec {
  bid: string;
  name: string;
  cid: string;
  ip: string;
}

const MAX_BANS = 200;

interface Bucket {
  tokens: number;
  last: number;
}

interface PlayerState {
  id: string;
  name: string;
  skin: Skin;
  p: Vec3;
  r: Rot;
  joined: boolean;
  host: boolean;
  cid: string;
  ip: string;
  setB: Bucket;
  chatB: Bucket;
}

const EDIT_BATCH = 3000;
const MAX_DROPS = 300;
const DROP_TTL_MS = 5 * 60 * 1000;
const PICKUP_XZ = 4; // 回収の許容水平距離(落下中・ラグを考慮して緩め)
const PICKUP_DY_UP = 64; // ドロップは落ちるだけなので、元の高さより上は大きく許容

interface Drop {
  eid: string;
  x: number;
  y: number;
  z: number;
  b: number;
  at: number;
}

/**
 * 1ルーム = 1 Durable Object。
 * - WebSocket Hibernation API を使用(誰も操作していない間は課金対象外)
 * - ワールドは「シードから決定的に生成される地形 + 編集差分」。差分だけをチャンク単位で
 *   Durable Object Storage(SQLite バックエンド)に永続保存する。
 */
export class Room extends DurableObject<Env> {
  private meta: Meta | null = null;
  /** key "cx,cz" -> Uint8Array(16384)。255 = 未編集、それ以外 = ブロックID(0=空気) */
  private chunks = new Map<string, Uint8Array>();
  private mem = new Map<WebSocket, PlayerState>();
  private bans: BanRec[] = [];
  private left = new WeakSet<WebSocket>();
  /** ドロップ中のアイテム(メモリのみ。Durable Object が再起動したら消える) */
  private drops = new Map<string, Drop>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.meta = (await ctx.storage.get<Meta>("meta")) ?? null;
      this.bans = (await ctx.storage.get<BanRec[]>("bans")) ?? [];
      if (this.meta) {
        const all = await ctx.storage.list<Uint8Array>({ prefix: "c:" });
        for (const [k, v] of all) this.chunks.set(k.slice(2), v);
      }
    });
  }

  // ---- RPC ----
  async create(code: string, seed: number, mode: GameMode = "creative", hostToken = ""): Promise<boolean> {
    if (this.meta) return false;
    this.meta = { code, seed, createdAt: Date.now(), mode: sanitizeMode(mode), hostToken: sanitizeToken(hostToken) || undefined };
    await this.ctx.storage.put("meta", this.meta);
    return true;
  }

  async info(): Promise<{ exists: boolean; players: number; max: number; mode: GameMode }> {
    return {
      exists: !!this.meta,
      mode: this.meta?.mode ?? "creative",
      players: this.ctx.getWebSockets().length,
      max: MAX_PLAYERS,
    };
  }

  // ---- WebSocket ----
  async fetch(request: Request): Promise<Response> {
    if (!this.meta) return new Response("room not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) {
      return new Response("room full", { status: 409 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const st: PlayerState = {
      id: crypto.randomUUID().slice(0, 8),
      name: "",
      skin: DEFAULT_SKIN,
      p: [0, 40, 0],
      r: [0, 0],
      joined: false,
      host: false,
      cid: "",
      ip: request.headers.get("CF-Connecting-IP") ?? "",
      setB: { tokens: 30, last: now },
      chatB: { tokens: 5, last: now },
    };
    server.serializeAttachment(st);
    this.mem.set(server, st);
    return new Response(null, { status: 101, webSocket: client });
  }

  private player(ws: WebSocket): PlayerState {
    let p = this.mem.get(ws);
    if (!p) {
      const a = ws.deserializeAttachment() as PlayerState | null;
      p = a ?? {
        id: crypto.randomUUID().slice(0, 8), name: "Player", skin: DEFAULT_SKIN, p: [0, 40, 0], r: [0, 0],
        joined: false, host: false, cid: "", ip: "",
        setB: { tokens: 30, last: Date.now() }, chatB: { tokens: 5, last: Date.now() },
      };
      this.mem.set(ws, p);
    }
    return p;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string" || raw.length > 4096 || !this.meta) return;
    if (this.left.has(ws)) return; // キック/BAN済みソケットからの操作は無視
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const me = this.player(ws);
    if (!msg || typeof msg !== "object") return;

    if (msg.t === "hello") {
      if (me.joined) return;
      me.cid = sanitizeToken(msg.cid);
      const token = sanitizeToken(msg.hostToken);
      me.host = !!token && !!this.meta.hostToken && token === this.meta.hostToken;
      // BAN 判定(ホスト本人は常に入室可能。自分を締め出さないため)
      if (!me.host && this.isBanned(me)) {
        this.send(ws, { t: "kicked", reason: "このルームからBANされています" });
        this.left.add(ws);
        try { ws.close(4003, "banned"); } catch { /* already closed */ }
        return;
      }
      // 名前: 英数字と _ のみ・空は不可・他の入室者と重複不可(大文字小文字を区別しない)
      const name = validateName(msg.name);
      if (!name) return this.refuse(ws, NAME_RULE);
      const key = nameKey(name);
      for (const s of this.ctx.getWebSockets()) {
        if (s === ws || this.left.has(s)) continue;
        const o = this.player(s);
        if (o.joined && nameKey(o.name) === key) return this.refuse(ws, "その名前は既に使われています");
      }
      me.name = name;
      me.skin = sanitizeSkin(msg.skin);
      me.p = sanitizeVec3(msg.p, [0, 40, 0]);
      me.r = sanitizeRot(msg.r, [0, 0]);
      me.joined = true;
      ws.serializeAttachment(me);

      const edits = this.allEdits();
      const others: PlayerInfo[] = [];
      for (const s of this.ctx.getWebSockets()) {
        if (s === ws) continue;
        const o = this.player(s);
        if (o.joined) others.push(this.info2(o));
      }
      this.send(ws, {
        t: "init", id: me.id, code: this.meta.code, seed: this.meta.seed,
        now: Date.now(), t0: this.meta.createdAt, players: others, editCount: edits.length / 4,
        mode: this.meta.mode ?? "creative", host: me.host,
        drops: this.liveDrops().map(({ eid, x, y, z, b }) => ({ eid, x, y, z, b })),
      });
      const step = EDIT_BATCH * 4;
      if (edits.length === 0) {
        this.send(ws, { t: "edits", list: [], done: true });
      } else {
        for (let i = 0; i < edits.length; i += step) {
          this.send(ws, { t: "edits", list: edits.slice(i, i + step), done: i + step >= edits.length });
        }
      }
      this.broadcast({ t: "join", player: this.info2(me) }, ws);
      return;
    }

    if (!me.joined) return;

    switch (msg.t) {
      case "pos": {
        me.p = sanitizeVec3(msg.p, me.p);
        me.r = sanitizeRot(msg.r, me.r);
        this.broadcast({ t: "pos", id: me.id, p: me.p, r: me.r }, ws);
        return;
      }
      case "set": {
        if (!this.take(me.setB, 30, 20)) return;
        const { x, y, z, b } = msg;
        if (!isValidSet(x, y, z, b)) return;
        const dx = x + 0.5 - me.p[0], dy = y + 0.5 - (me.p[1] + 1.6), dz = z + 0.5 - me.p[2];
        if (dx * dx + dy * dy + dz * dz > SERVER_REACH * SERVER_REACH) {
          this.send(ws, { t: "reject", x, y, z });
          return;
        }
        const ok = await this.applyEdit(x, y, z, b);
        if (!ok) {
          this.send(ws, { t: "reject", x, y, z });
          return;
        }
        this.broadcast({ t: "set", x, y, z, b, id: me.id });
        // サバイバルで壊したブロックはドロップ(エンティティ)になる。種類はクライアント申告だが、
        // 「自分が壊した座標」にしか出せず、レート制限・個数上限がある。
        if (b === 0 && msg.d !== undefined && (this.meta.mode ?? "creative") === "survival") {
          const d = msg.d;
          if (Number.isInteger(d) && d >= 1 && d <= BLOCK_COUNT && d !== B.BEDROCK && d !== B.WATER) this.spawnDrop(x, y, z, d);
        }
        return;
      }
      case "pickup": {
        if (!this.take(me.setB, 30, 20)) return;
        const eid = typeof msg.eid === "string" ? msg.eid : "";
        const dr = this.drops.get(eid);
        if (!dr) { this.send(ws, { t: "gone", eid, by: "" }); return; } // 既に無い → 要求元の表示も消す
        const dx = dr.x + 0.5 - me.p[0], dz = dr.z + 0.5 - me.p[2];
        const up = dr.y - me.p[1];
        if (dx * dx + dz * dz > PICKUP_XZ * PICKUP_XZ || up > PICKUP_DY_UP || up < -4) return;
        this.drops.delete(eid);
        this.broadcast({ t: "gone", eid, by: me.id });
        return;
      }
      case "chat": {
        if (!this.take(me.chatB, 5, 1)) return;
        const text = sanitizeChat(msg.text);
        if (!text) return;
        if (text.startsWith("/")) { await this.command(ws, me, text); return; }
        this.broadcast({ t: "chat", id: me.id, name: me.name, text });
        return;
      }
      // ---- ホスト専用コマンド。権限はサーバー側で必ず検証する ----
      case "kick":
      case "ban": {
        if (!me.host) return;
        const target = this.findById(typeof msg.id === "string" ? msg.id : "");
        if (!target || target.ws === ws || target.st.host) return; // 自分・ホストは対象外
        if (msg.t === "ban") {
          this.bans.push({ bid: crypto.randomUUID().slice(0, 8), name: target.st.name, cid: target.st.cid, ip: target.st.ip });
          if (this.bans.length > MAX_BANS) this.bans.shift();
          await this.ctx.storage.put("bans", this.bans);
        }
        this.evict(target.ws, msg.t === "ban" ? "ホストによってBANされました" : "ホストによってキックされました");
        this.broadcast({ t: "chat", id: "", name: "", text: `${target.st.name} が${msg.t === "ban" ? "BAN" : "キック"}されました` });
        return;
      }
      case "unban": {
        if (!me.host) return;
        const n = this.bans.length;
        this.bans = this.bans.filter((b) => b.bid !== msg.bid);
        if (this.bans.length !== n) await this.ctx.storage.put("bans", this.bans);
        this.send(ws, { t: "bans", list: this.banList() });
        return;
      }
      case "bans": {
        if (!me.host) return;
        this.send(ws, { t: "bans", list: this.banList() });
        return;
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.leave(ws);
    try { ws.close(1000, "bye"); } catch { /* already closed */ }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.leave(ws);
  }

  // ---- helpers ----
  private leave(ws: WebSocket) {
    if (this.left.has(ws)) return; // 二重通知を防ぐ(evict と close イベントの両方から呼ばれる)
    this.left.add(ws);
    const me = this.mem.get(ws) ?? (ws.deserializeAttachment() as PlayerState | null);
    this.mem.delete(ws);
    if (me?.joined) {
      me.joined = false;
      this.broadcast({ t: "leave", id: me.id, name: me.name }, ws);
    }
  }

  /** 入室を拒否してエラーを返し、切断する */
  private refuse(ws: WebSocket, message: string) {
    this.send(ws, { t: "error", message });
    this.left.add(ws);
    try { ws.close(4002, "refused"); } catch { /* already closed */ }
  }

  // ---- ドロップ ----
  private liveDrops(): Drop[] {
    const now = Date.now();
    for (const [id, d] of this.drops) {
      if (now - d.at > DROP_TTL_MS) { this.drops.delete(id); this.broadcast({ t: "gone", eid: id, by: "" }); }
    }
    return Array.from(this.drops.values());
  }

  private spawnDrop(x: number, y: number, z: number, b: number) {
    this.liveDrops();
    while (this.drops.size >= MAX_DROPS) {
      const oldest = this.drops.keys().next().value as string;
      this.drops.delete(oldest);
      this.broadcast({ t: "gone", eid: oldest, by: "" });
    }
    const eid = crypto.randomUUID().slice(0, 8);
    this.drops.set(eid, { eid, x, y, z, b, at: Date.now() });
    this.broadcast({ t: "drop", eid, x, y, z, b });
  }

  private clearDrops() {
    for (const id of this.drops.keys()) this.broadcast({ t: "gone", eid: id, by: "" });
    this.drops.clear();
  }

  // ---- コマンド(サーバー管理者=ホスト専用) ----
  private sys(ws: WebSocket, text: string) {
    this.send(ws, { t: "chat", id: "", name: "", text });
  }

  private async command(ws: WebSocket, me: PlayerState, text: string) {
    const [raw, ...args] = text.slice(1).trim().split(/\s+/);
    const cmd = raw.toLowerCase();
    if (cmd !== "gamemode") { this.sys(ws, `不明なコマンドです: /${raw}`); return; }
    if (!me.host) { this.sys(ws, "このコマンドはサーバー管理者(ホスト)のみ使えます"); return; }
    const a = (args[0] ?? "").toLowerCase();
    let mode: GameMode | null = null;
    if (a) {
      if ("survival".startsWith(a)) mode = "survival"; // s / su / surv ... どれでも可
      else if ("creative".startsWith(a)) mode = "creative"; // c / cr ...
    }
    if (!mode) { this.sys(ws, "使い方: /gamemode survival | creative  (頭文字 s / c でも可)"); return; }
    const label = mode === "survival" ? "サバイバル" : "クリエイティブ";
    if ((this.meta!.mode ?? "creative") === mode) { this.sys(ws, `既に${label}です`); return; }
    this.meta!.mode = mode;
    await this.ctx.storage.put("meta", this.meta);
    if (mode === "creative") this.clearDrops();
    this.broadcast({ t: "mode", mode });
    this.broadcast({ t: "chat", id: "", name: "", text: `${me.name} がゲームモードを${label}に変更しました` });
  }

  /** 対象を理由つきで切断し、退室を通知する */
  private evict(ws: WebSocket, reason: string) {
    this.send(ws, { t: "kicked", reason });
    this.leave(ws);
    try { ws.close(4001, "kicked"); } catch { /* already closed */ }
  }

  private findById(id: string): { ws: WebSocket; st: PlayerState } | null {
    if (!id) return null;
    for (const s of this.ctx.getWebSockets()) {
      if (this.left.has(s)) continue;
      const st = this.player(s);
      if (st.joined && st.id === id) return { ws: s, st };
    }
    return null;
  }

  private isBanned(p: PlayerState): boolean {
    return this.bans.some((b) => (b.cid && b.cid === p.cid) || (b.ip && b.ip === p.ip));
  }

  private banList(): BanEntry[] {
    return this.bans.map((b) => ({ bid: b.bid, name: b.name }));
  }

  private info2(p: PlayerState): PlayerInfo {
    return { id: p.id, name: p.name, skin: p.skin, p: p.p, r: p.r, host: p.host || undefined };
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* closed */ }
  }

  private broadcast(msg: ServerMsg, except?: WebSocket) {
    const data = JSON.stringify(msg);
    for (const s of this.ctx.getWebSockets()) {
      if (s === except || this.left.has(s)) continue;
      if (!this.player(s).joined) continue;
      try { s.send(data); } catch { /* closed */ }
    }
  }

  private take(b: Bucket, capacity: number, perSec: number): boolean {
    const now = Date.now();
    b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * perSec);
    b.last = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private async applyEdit(x: number, y: number, z: number, b: number): Promise<boolean> {
    const key = `${chunkCoord(x)},${chunkCoord(z)}`;
    let arr = this.chunks.get(key);
    if (!arr) {
      if (this.chunks.size >= MAX_CHUNK_RECORDS) return false;
      arr = new Uint8Array(CHUNK_VOLUME).fill(NO_EDIT);
      this.chunks.set(key, arr);
    }
    arr[localIndex(x, y, z)] = b;
    await this.ctx.storage.put("c:" + key, arr);
    return true;
  }

  private allEdits(): number[] {
    const out: number[] = [];
    for (const [key, arr] of this.chunks) {
      const [cx, cz] = key.split(",").map(Number);
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] === NO_EDIT) continue;
        out.push(cx * CHUNK_SIZE + (i & 15), i >> 8, cz * CHUNK_SIZE + ((i >> 4) & 15), arr[i]);
      }
    }
    return out;
  }
}
