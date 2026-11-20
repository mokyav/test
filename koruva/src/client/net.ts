import type { ClientMsg, GameMode, ServerMsg } from "../../shared/protocol";

export type NetHandler = (msg: ServerMsg) => void;

export async function createRoom(mode: GameMode): Promise<{ code: string; hostToken: string }> {
  const res = await fetch("/api/rooms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!res.ok) throw new Error("ルームを作成できませんでした");
  return (await res.json()) as { code: string; hostToken: string };
}

export async function checkRoom(code: string): Promise<void> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error("ルーム情報を取得できませんでした");
  const info = (await res.json()) as { exists: boolean; players: number; max: number };
  if (!info.exists) throw new Error("そのルームコードは存在しません");
  if (info.players >= info.max) throw new Error("ルームが満員です");
}

export class Net {
  private ws: WebSocket | null = null;
  private pingTimer = 0;
  onMessage: NetHandler = () => {};
  onClose: (reason: string) => void = () => {};

  connect(code: string, hello: Extract<ClientMsg, { t: "hello" }>): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws/${code}`);
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        this.send(hello);
        this.pingTimer = window.setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000);
        resolve();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string" || ev.data === "pong") return;
        try { this.onMessage(JSON.parse(ev.data) as ServerMsg); } catch (e) { console.error(e); }
      };
      ws.onerror = () => { if (!opened) reject(new Error("サーバーに接続できませんでした")); };
      ws.onclose = () => {
        clearInterval(this.pingTimer);
        if (!opened) reject(new Error("サーバーに接続できませんでした"));
        else if (this.ws === ws) { this.ws = null; this.onClose("サーバーとの接続が切れました"); }
      };
    });
  }

  get connected() { return this.ws?.readyState === WebSocket.OPEN; }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.pingTimer);
    ws?.close(1000);
  }
}
