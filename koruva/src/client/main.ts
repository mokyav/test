import * as THREE from "three";
import { B, BLOCKS, PLACEABLE } from "../../shared/blocks";
import { DAY_LENGTH_SEC, REACH, SEA_LEVEL } from "../../shared/constants";
import type { BanEntry, GameMode, PlayerInfo, ServerMsg, Skin } from "../../shared/protocol";
import { NAME_RULE, validateName } from "../../shared/validate";
import { createAtlasCanvas } from "./atlas";
import { ChunkView } from "./chunkview";
import { DropEntities } from "./drops";
import { Net, checkRoom, createRoom } from "./net";
import { EYE_H, PLAYER_H, PLAYER_W, collides, inLiquid, moveBody, raycast, type Body, type RayHit } from "./physics";
import { PlayerModel, RemotePlayers } from "./remote";
import {
  K_SETTINGS, clientId, deleteSolo, getRaw, loadHostToken, loadProfile, loadRoomPlayer, loadSolo, saveHostToken, saveProfile, saveRoomPlayer, saveSolo,
  type PlayerSave, type Profile,
} from "./save";
import { Sky, skyAt } from "./sky";
import { $, Chat, Hotbar, drawSkinPreview, randomSkin, renderHearts, renderHunger, toast, type InvItem } from "./ui";
import { World } from "./world";
import { heightAt } from "./worldgen";

THREE.ColorManagement.enabled = false;

type State = "title" | "loading" | "paused" | "playing" | "inventory" | "chat";
const DEFAULT_HOTBAR: number[] = [B.GRASS, B.DIRT, B.STONE, B.PLANKS, B.LOG, B.GLASS, B.BRICK, B.LAMP, B.SAND];
const MODE_NAME: Record<GameMode, string> = { creative: "クリエイティブ", survival: "サバイバル" };
const MODE_DESC: Record<GameMode, string> = {
  creative: "飛行OK・ブロック無限・すぐ壊せる",
  survival: "飛行不可・ブロックを集めて使う・体力あり",
};
const MAX_HP = 20;
const MAX_HUNGER = 20;
/** 満腹度がこれ以上あるときだけ体力が自然回復する */
const REGEN_MIN_HUNGER = 14;
const MAX_STACK = 999;
/** サバイバルでブロックを壊すのにかかる秒数(長押し) */
const HARDNESS: Record<number, number> = {
  [B.LEAVES]: 0.25, [B.GLASS]: 0.35, [B.SNOW]: 0.3,
  [B.DIRT]: 0.55, [B.GRASS]: 0.6, [B.SAND]: 0.5, [B.GRAVEL]: 0.6,
  [B.LOG]: 1.1, [B.PLANKS]: 1.0,
  [B.STONE]: 1.8, [B.COBBLE]: 1.8, [B.BRICK]: 1.8, [B.ORE]: 2.4, [B.LAMP]: 0.5,
  [B.RED]: 0.8, [B.BLUE]: 0.8, [B.YELLOW]: 0.8, [B.WHITE]: 0.8,
};
/** 壊したときに手に入るブロック(無ければ同じブロック) */
const DROPS: Record<number, number> = { [B.GRASS]: B.DIRT, [B.STONE]: B.COBBLE };

class Game {
  // three
  canvas = $<HTMLCanvasElement>("gl");
  renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: "high-performance" });
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, 1, 0.05, 400);
  world = new World(1);
  view = new ChunkView(this.world);
  sky = new Sky();
  remotes = new RemotePlayers();
  ownModel: PlayerModel | null = null;
  highlight: THREE.LineSegments;
  atlas = createAtlasCanvas();
  drops = new DropEntities(this.atlas);

  // state
  state: State = "title";
  mode: "solo" | "room" = "solo";
  roomCode = "";
  myId = "";
  net = new Net();
  profile: Profile = loadProfile();
  settings = { rd: 6, sens: 5 };

  body: Body = { x: 0.5, y: 60, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false };
  yaw = 0;
  pitch = 0;
  fly = false;
  thirdPerson = false;
  keys = new Set<string>();
  lastSpace = 0;
  hotbar: number[] = [...DEFAULT_HOTBAR];
  sel = 0;
  // ゲームモード / ホスト
  gameMode: GameMode = "creative";
  selMode: GameMode = "creative"; // タイトル画面で選択中(ルーム作成用)
  isHost = false;
  kickMsg = "";
  bans: BanEntry[] = [];
  // サバイバル
  counts: number[] = new Array(BLOCKS.length).fill(0);
  health = MAX_HP;
  hunger = MAX_HUNGER;
  /** 空腹の消耗量の端数(1.0 たまるごとに満腹度が1減る) */
  exhaustion = 0;
  starveT = 0;
  regenT = 0;
  peakY = 0;
  wasGround = true;
  digKey = "";
  digT = 0;
  lastDeny = 0;
  lockReqAt = 0;
  lockRetries = 0;
  time = 0.05;
  clockOffset = 0;
  t0 = 0;
  target: RayHit | null = null;
  mouseL = false;
  mouseR = false;
  lastBreak = 0;
  lastPlace = 0;
  pending = new Map<string, number>();
  lastSend = 0;
  lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  lastAutosave = 0;
  fps = 0;
  fpsAcc = 0;
  fpsN = 0;
  lastT = performance.now();
  loadStart = 0;
  loadingFor: "world" | "net" = "world";
  ready = false;

  hotbarUI: Hotbar;
  chat = new Chat();
  spawn: [number, number, number] = [0.5, 40, 0.5];

  constructor() {
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene.add(this.view.group, this.sky.group, this.remotes.group, this.drops.group);
    this.camera.rotation.order = "YXZ";
    this.scene.add(this.camera);
    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
      new THREE.LineBasicMaterial({ color: 0x000000 }),
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    try {
      const s = JSON.parse(getRaw(K_SETTINGS) || "null");
      if (s) this.settings = { rd: clampN(s.rd, 3, 12, 6), sens: clampN(s.sens, 1, 10, 5) };
    } catch { /* ignore */ }
    this.view.renderDistance = this.settings.rd;

    this.hotbarUI = new Hotbar(
      this.atlas,
      () => ({ hotbar: this.hotbar, sel: this.sel, count: (id) => this.countOf(id) }),
      (i) => { this.sel = i; this.hotbarUI.refresh(); },
      (id) => {
        if (this.survival && this.counts[id] <= 0) return;
        this.hotbar[this.sel] = id; this.hotbarUI.refresh(); toast(BLOCKS[id].name);
      },
    );
    this.hotbarUI.refresh();

    this.bindUI();
    this.bindInput();
    addEventListener("resize", () => this.resize());
    this.resize();
    addEventListener("beforeunload", () => this.autosave(true));
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    this.renderer.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  /** サバイバルはルーム作成時にモードを選んだ場合のみ(ソロは常にクリエイティブ) */
  get survival() { return this.mode === "room" && this.gameMode === "survival"; }
  /** ブロックの所持数。null = 無限(クリエイティブ) */
  countOf(id: number): number | null { return this.survival ? this.counts[id] ?? 0 : null; }

  // ------------------------------------------------------------ UI wiring
  bindUI() {
    const nameEl = $<HTMLInputElement>("name");
    const cols = { skin: $<HTMLInputElement>("c-skin"), hair: $<HTMLInputElement>("c-hair"), shirt: $<HTMLInputElement>("c-shirt"), pants: $<HTMLInputElement>("c-pants") };
    const preview = $<HTMLCanvasElement>("skinpreview");
    const syncSkin = () => {
      this.profile.skin = { skin: cols.skin.value, hair: cols.hair.value, shirt: cols.shirt.value, pants: cols.pants.value };
      drawSkinPreview(preview, this.profile.skin);
    };
    const applySkin = (s: Skin) => { for (const k of Object.keys(cols) as (keyof Skin)[]) cols[k].value = s[k]; syncSkin(); };
    const NAME_BAD = /[^A-Za-z0-9_]/g;
    nameEl.value = this.profile.name.replace(NAME_BAD, "").slice(0, 16);
    // 使えない文字(空白・記号・日本語など)は入力した時点で取り除く。IME変換中は触らない。
    const filterName = () => { const f = nameEl.value.replace(NAME_BAD, ""); if (f !== nameEl.value) nameEl.value = f; };
    nameEl.addEventListener("input", (e) => { if (!(e as InputEvent).isComposing) filterName(); });
    nameEl.addEventListener("compositionend", filterName);
    applySkin(this.profile.skin);
    for (const el of Object.values(cols)) el.addEventListener("input", syncSkin);
    $("skinrandom").addEventListener("click", () => applySkin(randomSkin()));

    const solo = loadSolo();
    if (solo) {
      $("btn-solo").textContent = "ソロ: 続きから";
      $("btn-solo-new").hidden = false;
    }
    /** 名前を検証する。空・使えない文字ならエラーを出して false(ゲームには入れない) */
    const prep = (): boolean => {
      const name = validateName(nameEl.value);
      if (!name) {
        $("titleerr").textContent = nameEl.value === "" ? "名前を入力してください(半角英数字と _ のみ)" : NAME_RULE;
        nameEl.focus();
        return false;
      }
      this.profile.name = name;
      saveProfile(this.profile);
      $("titleerr").textContent = "";
      return true;
    };
    $("btn-solo").addEventListener("click", () => { if (prep()) this.startSolo(false); });
    $("btn-solo-new").addEventListener("click", () => {
      if (!prep()) return;
      if (confirm("保存済みのソロワールドを破棄して新しく始めますか？")) { deleteSolo(); this.startSolo(true); }
    });
    const modeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>("#modesel .seg button"));
    for (const btn of modeBtns) {
      btn.addEventListener("click", () => {
        this.selMode = btn.dataset.mode === "survival" ? "survival" : "creative";
        for (const b of modeBtns) b.classList.toggle("on", b === btn);
        $("modedesc").textContent = MODE_DESC[this.selMode];
      });
    }
    $("btn-create").addEventListener("click", async () => {
      if (!prep()) return;
      try {
        this.showLoading("ルームを作成中…");
        const { code, hostToken } = await createRoom(this.selMode);
        saveHostToken(code, hostToken); // 作成者だけがホスト権限を持つ
        await this.startRoom(code);
      } catch (e) { this.backToTitle((e as Error).message); }
    });
    const join = async () => {
      if (!prep()) return;
      const code = $<HTMLInputElement>("joincode").value.trim().toUpperCase();
      if (code.length !== 6) { $("titleerr").textContent = "6文字のルームコードを入力してください"; return; }
      try { this.showLoading("ルームを確認中…"); await checkRoom(code); await this.startRoom(code); }
      catch (e) { this.backToTitle((e as Error).message); }
    };
    $("btn-join").addEventListener("click", join);
    $("joincode").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") join(); });
    const hash = location.hash.replace("#", "").trim().toUpperCase();
    if (/^[A-Z0-9]{6}$/.test(hash)) $<HTMLInputElement>("joincode").value = hash;

    // ポーズメニュー
    $("btn-resume").addEventListener("click", () => this.requestLock());
    $("btn-save").addEventListener("click", () => this.manualSave());
    $("btn-load").addEventListener("click", () => this.manualLoad());
    $("btn-quit").addEventListener("click", () => this.quit());
    $("btn-admin").addEventListener("click", () => this.openAdmin());
    $("btn-admin-close").addEventListener("click", () => this.closeAdmin());
    $("btn-copycode").addEventListener("click", () => this.copyLink());
    $("copylink").addEventListener("click", () => this.copyLink());
    const rd = $<HTMLInputElement>("rd"), sens = $<HTMLInputElement>("sens");
    rd.value = String(this.settings.rd); sens.value = String(this.settings.sens);
    const syncSettings = () => {
      this.settings.rd = +rd.value; this.settings.sens = +sens.value;
      $("rdval").textContent = String(this.settings.rd); $("sensval").textContent = String(this.settings.sens);
      this.view.renderDistance = this.settings.rd;
      localStorage.setItem(K_SETTINGS, JSON.stringify(this.settings));
    };
    rd.addEventListener("input", syncSettings); sens.addEventListener("input", syncSettings);
    syncSettings();

    // チャット入力
    const ci = $<HTMLInputElement>("chatinput");
    ci.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") {
        if (e.isComposing || e.keyCode === 229) return; // 日本語入力の変換確定の Enter では送信しない
        const text = ci.value.trim();
        if (text) {
          if (this.mode === "room") this.net.send({ t: "chat", text });
          else if (text.startsWith("/")) this.chat.add("ソロではコマンドは使えません(サーバー管理者専用です)");
          else this.chat.add(text, this.profile.name);
        }
        this.closeChat(true);
      } else if (e.key === "Escape") { e.preventDefault(); this.closeChat(true); }
    });
  }

  copyLink() {
    const url = `${location.origin}/#${this.roomCode}`;
    navigator.clipboard?.writeText(url).then(() => toast("招待リンクをコピーしました"), () => toast(`コード: ${this.roomCode}`));
  }

  // ------------------------------------------------------------ input
  bindInput() {
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === this.canvas;
      if (locked) {
        this.lockRetries = 0;
        if (this.state === "paused") { this.state = "playing"; $("pause").hidden = true; $("admin").hidden = true; }
      } else if (this.state === "playing") this.openPause("一時停止");
    });
    document.addEventListener("pointerlockerror", () => this.onLockError());
    this.canvas.addEventListener("click", () => { if (this.state === "playing" && document.pointerLockElement !== this.canvas) this.requestLock(); });
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    addEventListener("mousemove", (e) => {
      if (this.state !== "playing" || document.pointerLockElement !== this.canvas) return;
      const k = this.settings.sens * 0.0005;
      this.yaw -= e.movementX * k;
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch - e.movementY * k));
    });
    this.canvas.addEventListener("mousedown", (e) => {
      if (this.state !== "playing" || document.pointerLockElement !== this.canvas) return;
      e.preventDefault();
      if (e.button === 0) {
        this.mouseL = true;
        if (!this.survival) { this.doBreak(); this.lastBreak = performance.now(); } // サバイバルは長押しで掘る
      }
      else if (e.button === 2) { this.mouseR = true; this.doPlace(); this.lastPlace = performance.now(); }
      else if (e.button === 1) this.doPick();
    });
    addEventListener("mouseup", (e) => { if (e.button === 0) this.mouseL = false; if (e.button === 2) this.mouseR = false; });
    addEventListener("wheel", (e) => {
      if (this.state !== "playing") return;
      this.sel = (this.sel + (e.deltaY > 0 ? 1 : -1) + 9) % 9;
      this.hotbarUI.refresh();
      this.showHeld();
    }, { passive: true });
    addEventListener("blur", () => { this.keys.clear(); this.mouseL = this.mouseR = false; });

    addEventListener("keydown", (e) => {
      if (this.state === "title" || this.state === "loading") return;
      if (this.state === "chat") return;
      if (e.code === "Tab") { e.preventDefault(); if (this.mode === "room") this.showPlayers(true); return; }
      if (this.state === "inventory") {
        if (e.code === "KeyE" || e.code === "Escape") { e.preventDefault(); this.closeInventory(); }
        return;
      }
      if (this.state === "paused") {
        if (e.code === "Escape" && !e.repeat) {
          e.preventDefault();
          if (!$("admin").hidden) this.closeAdmin();
          else { this.lockReqAt = 0; this.tryLock(); } // Esc はユーザー操作扱いにならない場合がある → 失敗したらクリックを案内
        }
        return;
      }
      if (this.state !== "playing") return;
      // 通常は Esc でポインタロックが解除され pointerlockchange からメニューが開く。
      // ロックを持っていない状態で Esc が届いた場合のフォールバック。
      if (e.code === "Escape") { e.preventDefault(); this.openPause("一時停止"); return; }
      if (e.repeat) { this.keys.add(e.code); return; }
      this.keys.add(e.code);
      if (/^Digit[1-9]$/.test(e.code)) { this.sel = +e.code.slice(5) - 1; this.hotbarUI.refresh(); this.showHeld(); }
      else if (e.code === "KeyE") { e.preventDefault(); this.openInventory(); }
      else if (e.code === "KeyT" || e.code === "Enter" || e.code === "NumpadEnter") { e.preventDefault(); this.openChat(); }
      else if (e.code === "KeyV") { this.thirdPerson = !this.thirdPerson; toast(this.thirdPerson ? "三人称視点" : "一人称視点"); }
      else if (e.code === "Space") {
        const now = performance.now();
        if (now - this.lastSpace < 300) {
          if (this.survival) toast("サバイバルでは飛べません");
          else { this.fly = !this.fly; this.body.vy = 0; toast(this.fly ? "飛行モード ON" : "飛行モード OFF"); }
        }
        this.lastSpace = now;
      }
    });
    addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
      if (e.code === "Tab") this.showPlayers(false);
    });
  }

  /** クリック等のユーザー操作から呼ぶ。失敗しても数回は自動で再試行する。 */
  requestLock() {
    this.lockReqAt = performance.now();
    this.lockRetries = 0;
    this.tryLock();
  }

  tryLock() {
    try {
      const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => { /* 失敗は pointerlockerror で処理 */ });
    } catch { /* ignore */ }
  }

  onLockError() {
    if (this.state === "playing") { this.openPause("一時停止"); return; }
    if (this.state !== "paused") return;
    // Chrome は Esc で解除した直後(約1秒)のロック要求を拒否する。クリック直後なら少し待って自動再試行する。
    if (this.lockRetries < 3 && performance.now() - this.lockReqAt < 4000) {
      this.lockRetries++;
      setTimeout(() => { if (this.state === "paused") this.tryLock(); }, 1100);
    } else {
      $("pausemsg").textContent = "マウスをロックできませんでした。もう一度「ゲームに戻る」をクリックしてください";
    }
  }

  showHeld() { const id = this.hotbar[this.sel]; if (id) toast(BLOCKS[id].name); }

  showPlayers(show: boolean) {
    const el = $("playerlist");
    el.hidden = !show;
    if (!show) return;
    el.innerHTML = "<h3>プレイヤー</h3>";
    const add = (n: string) => { const d = document.createElement("div"); d.textContent = n; el.appendChild(d); };
    add(this.profile.name + "（あなた）");
    for (const p of this.remotes.names()) add(p.name);
  }

  openPause(title: string) {
    if (this.state === "title" || this.state === "loading") return;
    this.state = "paused";
    this.mouseL = this.mouseR = false;
    this.keys.clear();
    $("pausetitle").textContent = title;
    $("btn-load").hidden = false;
    $("btn-copycode").hidden = this.mode !== "room";
    $("btn-quit").textContent = this.mode === "room" ? "サーバーを抜ける" : "タイトルへ戻る";
    $("btn-admin").hidden = !(this.mode === "room" && this.isHost);
    $("admin").hidden = true;
    $("pausemsg").textContent = this.pauseText();
    $("pause").hidden = false;
  }
  pauseText() {
    return this.mode === "room"
      ? `ルーム ${this.roomCode}・${MODE_NAME[this.gameMode]}${this.isHost ? "・あなたはホスト" : ""}（ワールドはサーバーに自動保存）`
      : "ソロワールド（ブラウザに保存）";
  }

  // ---- サーバー管理(ホスト専用。権限はサーバー側でも検証される) ----
  openAdmin() {
    if (!this.isHost || this.mode !== "room") return;
    $("admin").hidden = false;
    this.net.send({ t: "bans" });
    this.renderAdmin();
  }
  closeAdmin() { $("admin").hidden = true; }

  renderAdmin() {
    const row = (name: string, tag: string, btns: [string, string, () => void][]) => {
      const r = document.createElement("div");
      r.className = "arow";
      const n = document.createElement("span");
      n.className = "nm"; n.textContent = name;
      r.appendChild(n);
      if (tag) { const t = document.createElement("span"); t.className = "tag"; t.textContent = tag; r.appendChild(t); }
      for (const [label, cls, fn] of btns) {
        const b = document.createElement("button");
        b.textContent = label; if (cls) b.className = cls;
        b.addEventListener("click", fn);
        r.appendChild(b);
      }
      return r;
    };
    const empty = (text: string) => { const d = document.createElement("div"); d.className = "empty"; d.textContent = text; return d; };

    const pl = $("adminplayers");
    pl.textContent = "";
    pl.appendChild(row(this.profile.name, "あなた（ホスト）", []));
    const others = this.remotes.names();
    if (!others.length) pl.appendChild(empty("他のプレイヤーはいません"));
    for (const p of others) {
      if (p.host) { pl.appendChild(row(p.name, "ホスト", [])); continue; }
      pl.appendChild(row(p.name, "", [
        ["キック", "", () => { this.net.send({ t: "kick", id: p.id }); toast(`${p.name} をキックしました`); }],
        ["BAN", "ban", () => { if (confirm(`${p.name} をBANしますか？\n(同じ端末・回線からは再入室できなくなります)`)) { this.net.send({ t: "ban", id: p.id }); toast(`${p.name} をBANしました`); } }],
      ]));
    }
    const bl = $("adminbans");
    bl.textContent = "";
    if (!this.bans.length) bl.appendChild(empty("BANされているプレイヤーはいません"));
    for (const b of this.bans) bl.appendChild(row(b.name, "", [["解除", "", () => this.net.send({ t: "unban", bid: b.bid })]]));
  }

  openInventory() {
    this.state = "inventory";
    this.keys.clear(); this.mouseL = this.mouseR = false;
    document.exitPointerLock();
    const items: InvItem[] = this.survival
      ? PLACEABLE.filter((id) => this.counts[id] > 0).map((id) => ({ id, count: this.counts[id] }))
      : PLACEABLE.map((id) => ({ id, count: null }));
    this.hotbarUI.setInventory(items);
    $("invhint").textContent = this.survival ? "持っているブロック。クリックで選択中のホットバー枠に設定" : "クリックで選択中のホットバー枠に設定";
    this.hotbarUI.refresh();
    $("inventory").hidden = false;
  }
  closeInventory() {
    $("inventory").hidden = true;
    this.state = "playing";
    this.requestLock();
  }
  openChat() {
    this.state = "chat";
    this.keys.clear(); this.mouseL = this.mouseR = false;
    document.exitPointerLock();
    const ci = $<HTMLInputElement>("chatinput");
    ci.hidden = false; ci.value = "";
    this.chat.setOpen(true);
    setTimeout(() => ci.focus(), 0);
  }
  closeChat(relock: boolean) {
    const ci = $<HTMLInputElement>("chatinput");
    ci.hidden = true; ci.blur();
    this.chat.setOpen(false);
    if (relock) { this.state = "playing"; this.requestLock(); }
    else this.openPause("一時停止");
  }

  // ------------------------------------------------------------ flow
  showLoading(text: string) {
    this.state = "loading";
    $("title").hidden = true;
    $("pause").hidden = true;
    $("loading").hidden = false;
    $("loadtext").textContent = text;
    $("loadbar").style.width = "5%";
  }

  backToTitle(err = "") {
    this.net.close();
    this.ready = false;
    this.state = "title";
    this.remotes.clear();
    this.view.clear();
    this.world.reset(1);
    $("hud").hidden = true;
    $("pause").hidden = true;
    $("admin").hidden = true;
    $("breakbar").hidden = true;
    $("loading").hidden = true;
    $("inventory").hidden = true;
    this.isHost = false;
    this.digKey = ""; this.digT = 0;
    $("title").hidden = false;
    $("titleerr").textContent = err;
    this.chat.setOpen(false);
    this.drops.clear();
    const solo = loadSolo();
    $("btn-solo").textContent = solo ? "ソロ: 続きから" : "ソロで遊ぶ";
    $("btn-solo-new").hidden = !solo;
    if (document.pointerLockElement) document.exitPointerLock();
  }

  quit() {
    this.autosave(true);
    this.backToTitle();
  }

  startSolo(fresh: boolean) {
    this.mode = "solo";
    this.gameMode = "creative"; // ソロは常にクリエイティブ
    this.isHost = false;
    this.fly = false;
    this.roomCode = "";
    this.chat.setScope("solo");
    this.drops.clear();
    const save = fresh ? null : loadSolo();
    const seed = save?.seed ?? (Math.random() * 2 ** 31) >>> 0;
    this.world.reset(seed);
    this.view.clear();
    this.remotes.clear();
    if (save) {
      this.world.importEdits(save.edits);
      this.time = save.time;
      this.applyPlayerSave(save.player);
    } else {
      this.time = 0.05;
      this.setSpawn();
    }
    this.beginLoading("ワールドを生成中…");
  }

  async startRoom(code: string) {
    this.mode = "room";
    this.roomCode = code;
    this.chat.setScope(code);
    this.drops.clear();
    this.kickMsg = "";
    this.bans = [];
    this.isHost = false;
    this.showLoading("ルームに接続中…");
    this.pending.clear();
    const saved = loadRoomPlayer(code);
    let gotInit = false;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ルームの読み込みがタイムアウトしました")), 20000);
      this.net.onMessage = (m) => {
        if (m.t === "init") {
          gotInit = true;
          this.myId = m.id;
          this.gameMode = m.mode;
          this.isHost = m.host;
          this.fly = false;
          this.world.reset(m.seed);
          this.view.clear();
          this.remotes.clear();
          this.t0 = m.t0;
          this.clockOffset = m.now - Date.now();
          for (const p of m.players) this.remotes.add(p);
          for (const d of m.drops ?? []) this.drops.add(d.eid, d.x, d.y, d.z, d.b);
        } else if (m.t === "edits" && gotInit) {
          this.world.importEdits(m.list);
          if (m.done) { clearTimeout(timer); resolve(); }
        } else if (m.t === "error") { this.kickMsg = m.message; clearTimeout(timer); reject(new Error(m.message)); }
        else if (m.t === "kicked") { this.kickMsg = m.reason; clearTimeout(timer); reject(new Error(m.reason)); }
        else this.onServerMsg(m);
      };
    });
    this.net.onClose = (reason) => {
      if (this.state !== "title") { this.backToTitle(this.kickMsg || reason); }
    };
    await this.net.connect(code, {
      t: "hello", name: this.profile.name, skin: this.profile.skin,
      p: saved?.pos, r: saved ? [saved.yaw, saved.pitch] : undefined,
      cid: clientId(), hostToken: loadHostToken(code) || undefined,
    });
    await done;
    if (saved) this.applyPlayerSave(saved); else this.setSpawn();
    this.time = this.roomTime();
    history.replaceState(null, "", `#${code}`);
    this.beginLoading("ワールドを生成中…");
  }

  roomTime(): number {
    const t = ((Date.now() + this.clockOffset - this.t0) / 1000 / DAY_LENGTH_SEC + 0.05) % 1;
    return t < 0 ? t + 1 : t;
  }

  setSpawn() {
    const h = Math.max(heightAt(this.world.seed, 0, 0), SEA_LEVEL);
    this.body = { x: 0.5, y: h + 2, z: 0.5, vx: 0, vy: 0, vz: 0, onGround: false };
    this.yaw = 0; this.pitch = 0;
    this.hotbar = this.survival ? new Array(9).fill(0) : [...DEFAULT_HOTBAR]; this.sel = 0;
    this.counts = new Array(BLOCKS.length).fill(0);
    this.health = MAX_HP;
    this.hunger = MAX_HUNGER; this.exhaustion = 0; this.starveT = 0;
    this.spawn = [0.5, h + 2, 0.5];
  }

  applyPlayerSave(p: PlayerSave) {
    this.body = { x: p.pos[0], y: p.pos[1], z: p.pos[2], vx: 0, vy: 0, vz: 0, onGround: false };
    this.yaw = p.yaw; this.pitch = p.pitch;
    this.hotbar = p.hotbar.length === 9 ? p.hotbar.map((v) => (v >= 1 && v < BLOCKS.length ? v : 0)) : this.survival ? new Array(9).fill(0) : [...DEFAULT_HOTBAR];
    this.sel = Math.min(8, Math.max(0, p.sel | 0));
    this.counts = new Array(BLOCKS.length).fill(0);
    // 所持数・体力・満腹度はモードに関係なく読み込む(/gamemode で後から切り替わっても失われないように)
    if (Array.isArray(p.counts)) {
      for (let i = 1; i < BLOCKS.length; i++) { const v = p.counts[i]; if (typeof v === "number" && v > 0) this.counts[i] = Math.min(MAX_STACK, Math.floor(v)); }
    }
    this.health = typeof p.health === "number" ? Math.min(MAX_HP, Math.max(1, Math.round(p.health))) : MAX_HP;
    this.hunger = typeof p.hunger === "number" ? Math.min(MAX_HUNGER, Math.max(0, Math.round(p.hunger))) : MAX_HUNGER;
    this.exhaustion = 0; this.starveT = 0;
    this.pruneHotbar();
    const h = Math.max(heightAt(this.world.seed, 0, 0), SEA_LEVEL);
    this.spawn = [0.5, h + 2, 0.5];
  }

  beginLoading(text: string) {
    this.showLoading(text);
    this.ready = false;
    this.loadStart = performance.now();
    this.hotbarUI.refresh();
    $("hud").hidden = false;
    $("roombadge").hidden = this.mode !== "room";
    $("roomcode").textContent = this.roomCode;
    this.updateSurvivalHud();
    this.loadingFor = "world";
  }

  finishLoading() {
    // めり込み回避
    for (let i = 0; i < 80 && collides(this.world, this.body.x, this.body.y, this.body.z); i++) this.body.y += 1;
    this.ready = true;
    $("loading").hidden = true;
    this.peakY = this.body.y; this.wasGround = true; this.regenT = 0;
    // 重要: state が "loading" のままだと openPause() が即 return し、メニューも出ず
    // ポインタロックも要求できなくなる(= マウスロックできないバグの原因)
    this.state = "paused";
    this.openPause("準備完了");
    if (this.mode === "room") this.chat.add(`ルーム ${this.roomCode} に参加しました`);
  }

  // ------------------------------------------------------------ server
  onServerMsg(m: ServerMsg) {
    switch (m.t) {
      case "join":
        this.remotes.add(m.player);
        this.chat.add(`${m.player.name} が入室しました`);
        toast(`${m.player.name} が入室しました`);
        if (!$("admin").hidden) this.renderAdmin();
        break;
      case "leave":
        this.remotes.remove(m.id);
        this.chat.add(`${m.name} が退室しました`);
        if (!$("admin").hidden) this.renderAdmin();
        break;
      case "kicked": this.kickMsg = m.reason; break;
      case "bans": this.bans = m.list; if (!$("admin").hidden) this.renderAdmin(); break;
      case "pos": this.remotes.move(m.id, m.p, m.r); break;
      case "drop": this.drops.add(m.eid, m.x, m.y, m.z, m.b); break;
      case "gone": {
        const b = this.drops.blockOf(m.eid);
        this.drops.remove(m.eid);
        // 自分が回収したときだけインベントリに入る
        if (m.by && m.by === this.myId && b !== null && this.survival) this.giveItem(b);
        break;
      }
      case "mode": this.applyGameMode(m.mode); break;
      case "set":
        this.pending.delete(`${m.x},${m.y},${m.z}`);
        this.world.setBlock(m.x, m.y, m.z, m.b);
        break;
      case "chat": if (m.name === "") this.chat.add(m.text); else this.chat.add(m.text, m.name); break;
      case "reject": {
        const k = `${m.x},${m.y},${m.z}`;
        const prev = this.pending.get(k);
        if (prev !== undefined) {
          if (this.survival) {
            // 楽観的に反映していた「設置」を巻き戻すので、使った分を返す(破壊はドロップ待ちなので何も戻さない)
            const cur = this.world.get(m.x, m.y, m.z);
            if (cur > 0 && prev === 0) this.giveItem(cur);
          }
          this.world.setBlock(m.x, m.y, m.z, prev); this.pending.delete(k);
        }
        break;
      }
      default: break;
    }
  }

  // ------------------------------------------------------------ block edit
  /** 反映できたら true */
  setLocal(x: number, y: number, z: number, b: number, drop?: number): boolean {
    const prev = this.world.get(x, y, z);
    if (prev === -1 || prev === b) return false;
    if (this.mode === "room") {
      if (!this.net.connected) { toast("サーバーに接続されていません"); return false; }
      const k = `${x},${y},${z}`;
      if (!this.pending.has(k)) this.pending.set(k, prev);
      this.net.send(drop ? { t: "set", x, y, z, b, d: drop } : { t: "set", x, y, z, b });
    }
    this.world.setBlock(x, y, z, b);
    return true;
  }

  deny(msg = "これは壊せません") {
    const now = performance.now();
    if (now - this.lastDeny > 900) { toast(msg); this.lastDeny = now; }
  }

  doBreak() {
    const t = this.target;
    if (!t) return;
    const id = this.world.get(t.x, t.y, t.z);
    if (id === B.BEDROCK || t.y < 1) { this.deny(); return; }
    // サバイバル: 壊したブロックはその場に「ドロップ(エンティティ)」として出る。拾うとインベントリに入る。
    const drop = this.survival && id > 0 && BLOCKS[id].render !== "liquid" ? DROPS[id] ?? id : undefined;
    if (this.setLocal(t.x, t.y, t.z, B.AIR, drop) && this.survival) this.addExhaustion(0.1);
  }

  /** サバイバル: アイテムを所持品に加える。ホットバーに空き枠があれば自動で入れる。 */
  giveItem(id: number, n = 1) {
    this.counts[id] = Math.min(MAX_STACK, (this.counts[id] || 0) + n);
    if (!this.hotbar.includes(id)) {
      const i = this.hotbar.indexOf(0);
      if (i >= 0) this.hotbar[i] = id;
    }
    this.hotbarUI.refresh();
    toast(`${BLOCKS[id].name} +${n}`, 700);
  }

  /** サバイバル: アイテムを1つ消費。0個になったらホットバーからも消す(0個のアイテムを残さない)。 */
  useItem(id: number) {
    this.counts[id] = Math.max(0, (this.counts[id] || 0) - 1);
    if (this.counts[id] === 0) this.hotbar = this.hotbar.map((h) => (h === id ? 0 : h));
    this.hotbarUI.refresh();
  }

  /** 所持数が0(または未所持)のアイテムをホットバーから取り除く */
  pruneHotbar() {
    if (!this.survival) return;
    this.hotbar = this.hotbar.map((h) => (h > 0 && (this.counts[h] ?? 0) > 0 ? h : 0));
  }

  addExhaustion(n: number) {
    if (!this.survival) return;
    this.exhaustion += n;
    while (this.exhaustion >= 1) {
      this.exhaustion -= 1;
      if (this.hunger > 0) { this.hunger--; renderHunger(this.hunger); }
    }
  }

  updateSurvivalHud() {
    $("hearts").hidden = !this.survival;
    $("hunger").hidden = !this.survival;
    renderHearts(this.health);
    renderHunger(this.hunger);
  }

  /** /gamemode でルームのモードが変わったとき */
  applyGameMode(mode: GameMode) {
    if (this.gameMode === mode) return;
    this.gameMode = mode;
    this.fly = false;
    this.stopDig();
    if (this.survival) {
      this.pruneHotbar();
    } else {
      this.drops.clear();
      // クリエイティブに戻ったら空いたホットバー枠を初期ブロックで埋める
      this.hotbar = this.hotbar.map((h, i) => (h > 0 ? h : this.hotbar.includes(DEFAULT_HOTBAR[i]) ? 0 : DEFAULT_HOTBAR[i]));
    }
    this.peakY = this.body.y; this.wasGround = this.body.onGround;
    this.updateSurvivalHud();
    this.hotbarUI.refresh();
    toast(`ゲームモード: ${MODE_NAME[mode]}`, 2200);
    if (this.state === "paused") $("pausemsg").textContent = this.pauseText();
    if (this.state === "inventory") this.openInventory();
  }

  /** サバイバル: 左ボタン長押しでブロックを掘る */
  updateDig(dt: number) {
    const t = this.target;
    const id = t ? this.world.get(t.x, t.y, t.z) : 0;
    if (!t || id <= 0) { this.stopDig(); return; }
    if (id === B.BEDROCK || t.y < 1) { this.deny(); this.stopDig(); return; }
    const key = `${t.x},${t.y},${t.z}`;
    if (key !== this.digKey) { this.digKey = key; this.digT = 0; }
    this.digT += dt;
    const need = HARDNESS[id] ?? 1;
    const bar = $("breakbar");
    bar.hidden = false;
    (bar.firstElementChild as HTMLElement).style.width = `${Math.min(100, (this.digT / need) * 100)}%`;
    if (this.digT >= need) { this.doBreak(); this.stopDig(); }
  }
  stopDig() {
    if (this.digKey === "" && this.digT === 0) return;
    this.digKey = ""; this.digT = 0;
    $("breakbar").hidden = true;
  }

  hurt(n: number) {
    if (!this.survival || n <= 0 || !this.ready) return;
    this.health = Math.max(0, this.health - n);
    renderHearts(this.health);
    if (this.health <= 0) this.die(); else toast(`ダメージ -${n / 2}♥`);
  }
  die() {
    const b = this.body;
    this.health = MAX_HP; renderHearts(this.health);
    this.hunger = MAX_HUNGER; this.exhaustion = 0; this.starveT = 0; renderHunger(this.hunger);
    b.x = this.spawn[0]; b.y = this.spawn[1] + 3; b.z = this.spawn[2]; b.vx = b.vy = b.vz = 0;
    this.peakY = b.y; this.wasGround = false;
    toast("倒れました… リスポーンします");
    this.chat.add("あなたは倒れました");
  }

  doPlace() {
    const t = this.target;
    const id = this.hotbar[this.sel];
    if (!t || !id) return;
    if (this.survival && this.counts[id] <= 0) { this.deny("そのブロックを持っていません"); return; }
    const x = t.x + t.nx, y = t.y + t.ny, z = t.z + t.nz;
    if (y < 1 || y >= 64) return;
    const cur = this.world.get(x, y, z);
    if (cur !== B.AIR && !(cur > 0 && BLOCKS[cur].render === "liquid")) return;
    if (BLOCKS[id].solid) {
      const b = this.body, hw = PLAYER_W / 2;
      if (b.x + hw > x && b.x - hw < x + 1 && b.y + PLAYER_H > y && b.y < y + 1 && b.z + hw > z && b.z - hw < z + 1) return;
    }
    if (this.setLocal(x, y, z, id) && this.survival) this.useItem(id);
  }

  doPick() {
    const t = this.target;
    if (!t) return;
    const id = this.world.get(t.x, t.y, t.z);
    if (id <= 0 || id === B.BEDROCK) return;
    if (this.survival) {
      // サバイバルでは持っているブロックだけ選べる
      const have = this.hotbar.indexOf(id);
      if (have >= 0) { this.sel = have; this.hotbarUI.refresh(); this.showHeld(); }
      else if ((this.counts[id] ?? 0) > 0) { this.hotbar[this.sel] = id; this.hotbarUI.refresh(); this.showHeld(); }
      else toast("そのブロックを持っていません");
      return;
    }
    this.hotbar[this.sel] = id;
    this.hotbarUI.refresh();
    this.showHeld();
  }

  // ------------------------------------------------------------ save
  playerSave(): PlayerSave {
    const base: PlayerSave = { pos: [this.body.x, this.body.y, this.body.z], yaw: this.yaw, pitch: this.pitch, hotbar: [...this.hotbar], sel: this.sel };
    base.counts = [...this.counts]; base.health = this.health; base.hunger = this.hunger;
    return base;
  }

  autosave(force = false) {
    if (!this.ready) return;
    if (this.mode === "solo") {
      saveSolo({ v: 1, seed: this.world.seed, edits: this.world.exportEdits(), time: this.time, player: this.playerSave(), savedAt: Date.now() });
    } else if (this.roomCode) {
      saveRoomPlayer(this.roomCode, this.playerSave());
    }
    this.lastAutosave = performance.now();
    void force;
  }

  manualSave() {
    this.autosave(true);
    $("pausemsg").textContent = this.mode === "solo" ? "セーブしました" : "プレイヤー位置を保存しました（ワールドはサーバーに自動保存されています）";
  }

  manualLoad() {
    if (this.mode === "solo") {
      const s = loadSolo();
      if (!s) { $("pausemsg").textContent = "セーブデータがありません"; return; }
      this.world.reset(s.seed);
      this.view.clear();
      this.world.importEdits(s.edits);
      this.time = s.time;
      this.applyPlayerSave(s.player);
      this.ready = false;
      this.state = "loading";
      $("pause").hidden = true;
      this.beginLoading("ロード中…");
    } else {
      const p = loadRoomPlayer(this.roomCode);
      if (!p) { $("pausemsg").textContent = "保存済みの位置がありません"; return; }
      this.applyPlayerSave(p);
      $("pausemsg").textContent = "保存した位置に戻りました";
    }
  }

  // ------------------------------------------------------------ frame
  frame(now: number) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.05, (now - this.lastT) / 1000);
    this.lastT = now;
    if (this.state === "title") {
      this.renderer.setClearColor(new THREE.Color(0.06, 0.08, 0.13));
      this.renderer.clear();
      return;
    }

    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc >= 0.5) { this.fps = Math.round(this.fpsN / this.fpsAcc); this.fpsAcc = 0; this.fpsN = 0; }

    const loading = this.state === "loading";
    this.view.update(this.body.x, this.body.z, loading ? 6 : 2, loading ? 6 : 3);

    if (loading && !this.ready) {
      const r = this.view.readyRatio(this.body.x, this.body.z, 2);
      $("loadbar").style.width = `${Math.round(5 + r * 95)}%`;
      if (r >= 0.99 || performance.now() - this.loadStart > 10000) this.finishLoading();
    }

    if (this.ready) {
      this.updatePlayer(dt, now);
      this.updateTarget(now);
      // ドロップの更新と回収(サバイバル・ルーム接続中のみ)。回収はサーバーが判定して全員に通知する。
      const picks = this.drops.update(dt, this.world, this.body.x, this.body.y, this.body.z, this.survival && this.net.connected);
      for (const eid of picks) this.net.send({ t: "pickup", eid });
      if (now - this.lastAutosave > 15000) this.autosave();
      if (this.mode === "room") this.sendPos(now);
    }

    // 時間と空
    this.time = this.mode === "room" && this.ready ? this.roomTime() : (this.time + dt / DAY_LENGTH_SEC) % 1;
    const sky = skyAt(this.time);
    const eye = this.camera.position;
    const under = this.ready && inLiquid(this.world, eye.x, eye.y, eye.z);
    $("underwater").hidden = !under;
    let fog: [number, number, number] = sky.skyColor;
    const far = Math.max(40, this.settings.rd * 16 - 6);
    let near = far * 0.55, farD = far;
    if (under) { fog = [0.12 * sky.light[0], 0.28 * sky.light[1], 0.55 * sky.light[2]]; near = 1; farD = 30; }
    this.renderer.setClearColor(new THREE.Color(fog[0], fog[1], fog[2]));
    this.view.uniforms.uFog.value.set(fog[0], fog[1], fog[2]);
    this.view.uniforms.uLight.value.set(sky.light[0], sky.light[1], sky.light[2]);
    this.view.setFog(near, farD);
    this.sky.group.visible = !under;
    this.sky.update(this.time, this.camera, sky);

    this.remotes.update(dt, 0.3 + 0.7 * sky.daylight);
    this.drops.setLight(0.3 + 0.7 * sky.daylight);
    this.updateOwnModel(dt, sky.daylight);
    this.updateInfo();
    this.renderer.render(this.scene, this.camera);
  }

  updatePlayer(dt: number, now: number) {
    const b = this.body;
    const active = this.state === "playing";
    const k = this.keys;
    if (!this.world.hasChunkAt(b.x, b.z)) return;

    const ix = active ? (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0) : 0;
    const iz = active ? (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0) : 0;
    const sprint = active && (k.has("ShiftLeft") || k.has("ShiftRight"));
    const jump = active && k.has("Space");
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = -sin * iz + cos * ix, wz = -cos * iz - sin * ix;
    const len = Math.hypot(wx, wz);
    if (len > 0) { wx /= len; wz /= len; }

    const feetWater = inLiquid(this.world, b.x, b.y + 0.3, b.z);
    const headWater = inLiquid(this.world, b.x, b.y + 1.4, b.z);
    let speed = 4.4;
    if (this.fly) speed = sprint ? 20 : 11;
    else if (feetWater) speed = 2.6;
    else if (sprint) speed = 6.4;

    const resp = this.fly ? 10 : b.onGround ? 14 : 4;
    const a = Math.min(1, dt * resp);
    b.vx += (wx * speed - b.vx) * a;
    b.vz += (wz * speed - b.vz) * a;

    if (this.fly) {
      const up = (jump ? 1 : 0) - (active && sprint ? 1 : 0);
      b.vy += (up * (sprint ? 14 : 9) - b.vy) * Math.min(1, dt * 10);
    } else if (feetWater) {
      b.vy -= 6 * dt;
      if (jump) b.vy = Math.min(b.vy + 28 * dt, 3.6);
      b.vy *= 1 - Math.min(1, dt * 2.5);
      if (headWater === false && jump && b.vy > 0) b.vy = Math.max(b.vy, 4.5);
    } else {
      b.vy = Math.max(-50, b.vy - 28 * dt);
      if (jump && b.onGround) b.vy = 8.6;
    }
    moveBody(this.world, b, dt);
    if (b.y < -30) {
      if (this.survival) this.die();
      else { b.x = this.spawn[0]; b.y = this.spawn[1] + 5; b.z = this.spawn[2]; b.vx = b.vy = b.vz = 0; toast("リスポーンしました"); }
    }

    if (this.survival) {
      // 落下ダメージ: 最高到達点からの落差が3ブロックを超えた分(水中は無効)
      if (feetWater) this.peakY = b.y;
      else if (b.onGround) {
        if (!this.wasGround) { const d = this.peakY - b.y; if (d > 3.2) this.hurt(Math.floor(d - 3)); }
        this.peakY = b.y;
      } else this.peakY = Math.max(this.peakY, b.y);
      this.wasGround = b.onGround;
      // 空腹: 時間で減る。ダッシュ中は減りが速い(雑な実装: 食べ物はまだ無い)
      const running = sprint && !this.fly && Math.hypot(b.vx, b.vz) > 1;
      this.addExhaustion(dt * (0.03 + (running ? 0.06 : 0)));
      // 満腹度が0だと4秒ごとに半ハートのダメージ(体力1までで、空腹では倒れない)
      if (this.hunger <= 0) {
        this.starveT += dt;
        if (this.starveT >= 4) {
          this.starveT = 0;
          if (this.health > 1) { this.health -= 1; renderHearts(this.health); toast("空腹でダメージ…", 1200); }
        }
      } else this.starveT = 0;
      // 自然回復: 満腹度が十分あるとき4秒ごとに半ハート(回復すると少し空腹になる)
      if (this.health < MAX_HP && this.hunger >= REGEN_MIN_HUNGER) {
        this.regenT += dt;
        if (this.regenT >= 4) { this.regenT = 0; this.health = Math.min(MAX_HP, this.health + 1); renderHearts(this.health); this.addExhaustion(0.25); }
      } else this.regenT = 0;
    }

    if (active) {
      if (this.survival) { if (this.mouseL) this.updateDig(dt); else this.stopDig(); }
      else if (this.mouseL && now - this.lastBreak > 190) { this.doBreak(); this.lastBreak = now; }
      if (this.mouseR && now - this.lastPlace > 220) { this.doPlace(); this.lastPlace = now; }
    } else if (this.survival) this.stopDig();

    // カメラ
    const cx = b.x, cy = b.y + EYE_H, cz = b.z;
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    if (this.thirdPerson) {
      const dx = Math.sin(this.yaw) * Math.cos(this.pitch), dy = -Math.sin(this.pitch), dz = Math.cos(this.yaw) * Math.cos(this.pitch);
      // 視線の後ろ方向に最大4ブロック、壁があれば手前で止める
      const h = raycast(this.world, cx, cy, cz, dx, dy, dz, 4);
      const dist = h ? Math.max(0.5, Math.hypot(h.x + 0.5 - cx, h.y + 0.5 - cy, h.z + 0.5 - cz) - 0.9) : 4;
      this.camera.position.set(cx + dx * dist, cy + dy * dist, cz + dz * dist);
    } else this.camera.position.set(cx, cy, cz);
  }

  updateTarget(now: number) {
    void now;
    if (this.state !== "playing") { this.highlight.visible = false; this.target = null; return; }
    const o = new THREE.Vector3(this.body.x, this.body.y + EYE_H, this.body.z);
    const d = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    this.target = raycast(this.world, o.x, o.y, o.z, d.x, d.y, d.z, REACH);
    if (this.target) { this.highlight.visible = true; this.highlight.position.set(this.target.x + 0.5, this.target.y + 0.5, this.target.z + 0.5); }
    else this.highlight.visible = false;
  }

  updateOwnModel(dt: number, daylight: number) {
    if (!this.ownModel) { this.ownModel = new PlayerModel(this.profile.skin, null); this.scene.add(this.ownModel.root); }
    const m = this.ownModel;
    m.root.visible = this.thirdPerson && this.ready;
    if (!m.root.visible) return;
    m.root.position.set(this.body.x, this.body.y, this.body.z);
    m.root.rotation.y = this.yaw + Math.PI;
    m.animate(dt, Math.hypot(this.body.vx, this.body.vz));
    m.setLight(0.3 + 0.7 * daylight);
  }

  sendPos(now: number) {
    if (!this.net.connected || now - this.lastSend < 80) return;
    const b = this.body, l = this.lastSent;
    const moved = Math.abs(b.x - l.x) + Math.abs(b.y - l.y) + Math.abs(b.z - l.z) > 0.01 || Math.abs(this.yaw - l.yaw) > 0.01 || Math.abs(this.pitch - l.pitch) > 0.01;
    if (!moved && now - this.lastSend < 1000) return;
    this.lastSend = now;
    this.lastSent = { x: b.x, y: b.y, z: b.z, yaw: this.yaw, pitch: this.pitch };
    const r2 = (n: number) => Math.round(n * 100) / 100;
    this.net.send({ t: "pos", p: [r2(b.x), r2(b.y), r2(b.z)], r: [r2(this.yaw), r2(this.pitch)] });
  }

  updateInfo() {
    if (!this.ready) return;
    const b = this.body, hrs = (this.time * 24 + 6) % 24;
    const hh = String(Math.floor(hrs)).padStart(2, "0"), mm = String(Math.floor((hrs % 1) * 60)).padStart(2, "0");
    const st = this.view.stats;
    $("info").textContent =
      `${this.fps} FPS   ${hh}:${mm}${this.fly ? "   飛行" : ""}   ${MODE_NAME[this.gameMode]}\n` +
      `XYZ ${b.x.toFixed(1)} ${b.y.toFixed(1)} ${b.z.toFixed(1)}\n` +
      `チャンク ${st.chunks} / 描画 ${st.meshed}   △ ${Math.round(st.triangles / 1000)}k` +
      (this.mode === "room" ? `\nプレイヤー ${this.remotes.count() + 1}人` : "");
  }
}

function clampN(v: unknown, lo: number, hi: number, def: number) {
  return typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def;
}

new Game();
export type { PlayerInfo };
