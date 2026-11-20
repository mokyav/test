import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from "../../shared/constants";
import { sanitizeMode } from "../../shared/validate";
import type { Env } from "./env";

export { Room } from "./room";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_CODE_LENGTH));
  return Array.from(bytes, (b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length]).join("");
}

function roomStub(env: Env, code: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ルーム作成
    if (path === "/api/rooms" && request.method === "POST") {
      let body: { mode?: unknown } = {};
      try { body = (await request.json()) as { mode?: unknown }; } catch { /* 本文なし = クリエイティブ */ }
      const mode = sanitizeMode(body?.mode);
      // ホスト本人だけが持つ秘密トークン。作成者にのみ返し、参加時に提示してもらう。
      const hostToken = crypto.randomUUID();
      for (let i = 0; i < 8; i++) {
        const code = generateCode();
        const seed = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
        const ok = await roomStub(env, code).create(code, seed, mode, hostToken);
        if (ok) return json({ code, mode, hostToken });
      }
      return json({ error: "ルームを作成できませんでした" }, 503);
    }

    // ルーム存在確認
    const info = path.match(/^\/api\/rooms\/([A-Za-z0-9]{6})$/);
    if (info && request.method === "GET") {
      return json(await roomStub(env, info[1].toUpperCase()).info());
    }

    // WebSocket 接続 → Durable Object へ
    const ws = path.match(/^\/ws\/([A-Za-z0-9]{6})$/);
    if (ws) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      return roomStub(env, ws[1].toUpperCase()).fetch(request);
    }

    if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
    // 静的アセットは wrangler の assets 設定により先に配信される。ここはフォールバック。
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
