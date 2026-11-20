import { BLOCKS } from "../../shared/blocks";
import type { Skin } from "../../shared/protocol";
import { blockIcon } from "./icons";
import { CHAT_HISTORY_MAX, loadChat, saveChat, type ChatLine } from "./save";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** スキンの2Dプレビュー(タイトル画面) */
export function drawSkinPreview(cv: HTMLCanvasElement, s: Skin) {
  const ctx = cv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, cv.width, cv.height);
  const k = cv.width / 16;
  const r = (x: number, y: number, w: number, h: number, c: string) => { ctx.fillStyle = c; ctx.fillRect(x * k, y * k, w * k, h * k); };
  r(4, 0, 8, 8, s.skin); r(4, 0, 8, 3, s.hair); r(3, 3, 1, 3, s.hair); r(12, 3, 1, 3, s.hair);
  r(5, 5, 2, 2, "#fff"); r(9, 5, 2, 2, "#fff"); r(6, 5, 1, 2, "#2a3550"); r(9, 5, 1, 2, "#2a3550");
  r(3, 8, 10, 10, s.shirt);
  r(0, 8, 3, 10, s.shirt); r(13, 8, 3, 10, s.shirt); r(0, 15, 3, 3, s.skin); r(13, 15, 3, 3, s.skin);
  r(4, 18, 4, 10, s.pants); r(8, 18, 4, 10, s.pants); r(4, 26, 4, 2, "#2b2b30"); r(8, 26, 4, 2, "#2b2b30");
}

const PALETTE = {
  skin: ["#f1c9a5", "#e8b48a", "#c68a5e", "#8d5a3b", "#5c3b27", "#f6d6c0"],
  hair: ["#2b1d14", "#4a3022", "#8a5a2b", "#d9b45a", "#c0392b", "#e5e5e5", "#3b82c4"],
  shirt: ["#3b82c4", "#d0453a", "#4aa860", "#e0b43a", "#8a56c6", "#e8e8ee", "#2f2f38"],
  pants: ["#2f3a63", "#3a3a40", "#6a4a2a", "#2d5a3d", "#7a2f3a", "#4d5d7a"],
};
export function randomSkin(): Skin {
  const p = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
  return { skin: p(PALETTE.skin), hair: p(PALETTE.hair), shirt: p(PALETTE.shirt), pants: p(PALETTE.pants) };
}

export interface InvItem { id: number; count: number | null } // count=null → 無限(クリエイティブ)

export class Hotbar {
  private slots: HTMLElement[] = [];
  private invSlots: HTMLElement[] = [];
  constructor(
    private atlas: HTMLCanvasElement,
    private get: () => { hotbar: number[]; sel: number; count: (id: number) => number | null },
    private onSelect: (i: number) => void,
    private onAssign: (blockId: number) => void,
  ) {
    const hb = $("hotbar"), ih = $("invhotbar");
    for (let i = 0; i < 9; i++) {
      hb.appendChild(this.mk(i, this.slots));
      ih.appendChild(this.mk(i, this.invSlots));
    }
  }
  /** インベントリ一覧を作り直す。クリエイティブは全ブロック、サバイバルは所持品のみ。 */
  setInventory(items: InvItem[]) {
    const grid = $("invgrid");
    grid.textContent = "";
    if (items.length === 0) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "まだアイテムを持っていません。ブロックを壊して集めよう";
      grid.appendChild(e);
      return;
    }
    for (const it of items) {
      const d = document.createElement("div");
      d.className = "slot";
      d.title = BLOCKS[it.id].name;
      d.innerHTML = `<img alt="${BLOCKS[it.id].name}" src="${blockIcon(this.atlas, it.id)}">` + (it.count !== null ? `<span class="c">${it.count}</span>` : "");
      d.addEventListener("click", () => this.onAssign(it.id));
      grid.appendChild(d);
    }
  }
  private mk(i: number, list: HTMLElement[]) {
    const d = document.createElement("div");
    d.className = "slot";
    d.addEventListener("click", (e) => { e.stopPropagation(); this.onSelect(i); });
    list.push(d);
    return d;
  }
  refresh() {
    const { hotbar, sel, count } = this.get();
    for (const list of [this.slots, this.invSlots]) {
      list.forEach((el, i) => {
        const id = hotbar[i];
        const c = id ? count(id) : null;
        el.className = "slot" + (i === sel ? " sel" : "") + (id && c === 0 ? " none" : "");
        el.title = id ? BLOCKS[id].name : "";
        el.innerHTML = (id ? `<img alt="" src="${blockIcon(this.atlas, id)}">` : "") + `<span class="n">${i + 1}</span>` +
          (id && c !== null ? `<span class="c">${c}</span>` : "");
      });
    }
  }
}

/** サバイバルの体力表示(ハート10個 = 20HP) */
export function renderHearts(hp: number) {
  const el = $("hearts");
  let html = "";
  for (let i = 0; i < 10; i++) {
    const v = hp - i * 2;
    html += `<span class="${v >= 2 ? "full" : v >= 1 ? "half" : "empty"}">${v >= 1 ? "♥" : "♡"}</span>`;
  }
  el.innerHTML = html;
}

/** 空腹ゲージ(10個 = 20pt)。右側に表示 */
export function renderHunger(v: number) {
  const el = $("hunger");
  let html = "";
  for (let i = 0; i < 10; i++) {
    const r = v - i * 2;
    html += `<span class="${r >= 2 ? "full" : r >= 1 ? "half" : "empty"}">🍗</span>`;
  }
  el.innerHTML = html;
}

export class Chat {
  private log = $("chatlog");
  private lines: HTMLElement[] = [];
  private history: ChatLine[] = [];
  private scope = "solo";
  private open = false;

  /** 保存先(ルームコード / "solo")を切り替えて履歴を読み込む */
  setScope(scope: string) {
    this.scope = scope || "solo";
    this.history = loadChat(this.scope);
    this.clearView();
  }

  private clearView() {
    this.log.textContent = "";
    this.lines = [];
  }

  private render(l: ChatLine): HTMLElement {
    const el = document.createElement("div");
    el.className = "line" + (l.name === undefined ? " sys" : "");
    if (l.name !== undefined) {
      const b = document.createElement("b");
      b.textContent = l.name;
      el.append(b, document.createTextNode(": " + l.text));
    } else el.textContent = l.text;
    return el;
  }

  add(text: string, name?: string) {
    const line: ChatLine = name === undefined ? { text } : { text, name };
    this.history.push(line);
    if (this.history.length > CHAT_HISTORY_MAX) this.history.splice(0, this.history.length - CHAT_HISTORY_MAX);
    saveChat(this.scope, this.history);

    const el = this.render(line);
    this.log.appendChild(el);
    this.lines.push(el);
    if (this.open) {
      // チャットを開いている間は履歴として全て残す
      while (this.lines.length > CHAT_HISTORY_MAX) this.lines.shift()!.remove();
      this.log.scrollTop = this.log.scrollHeight;
      return;
    }
    while (this.lines.length > 10) this.lines.shift()!.remove();
    setTimeout(() => { el.style.opacity = "0"; }, 9000);
    setTimeout(() => { el.remove(); this.lines = this.lines.filter((l) => l !== el); }, 9700);
  }

  /** 開いたら保存済みの履歴(最大30件)を全て表示。閉じたら通常の一時表示に戻す。 */
  setOpen(open: boolean) {
    this.open = open;
    this.clearView();
    this.log.classList.toggle("open", open);
    if (!open) return;
    for (const l of this.history) {
      const el = this.render(l);
      this.log.appendChild(el);
      this.lines.push(el);
    }
    this.log.scrollTop = this.log.scrollHeight;
  }
}

let toastTimer = 0;
export function toast(msg: string, ms = 1600) {
  const t = $("toast");
  t.textContent = msg;
  t.style.opacity = "1";
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { t.style.opacity = "0"; }, ms);
}
