import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

// What a job tells the card's open pages, as it goes.
export interface LiveEvent {
  job: number;
  status: "queued" | "running" | "done" | "failed";
  // What the widget says it is doing ("Claude is writing the spec").
  label: string;
  // A line of its log, when there is one.
  text?: string;
  at: string;
}

// What a run of the project's Claude workflow tells the open sprint pages
// (la-fabrique#113): one started, moved or ended.
export interface SprintEvent {
  kind: "claude_run" | "pull_request";
  issue: number | null;
  status: string;
  conclusion: string | null;
  url: string;
  at: string;
}

// One per card: it keeps the WebSockets of the pages open on the card and
// pushes them what Claude's job does (docs/decisions/0001). Asleep between
// two events (hibernation): an open page costs nothing while it waits.
export class CardLive extends DurableObject<Env> {
  // The last event, kept while the object is awake: a page that connects
  // in the meantime learns where the job is (otherwise from its own load).
  private last: LiveEvent | SprintEvent | null = null;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("A WebSocket is expected.", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    // A page that opens now learns where the job is.
    if (this.last) server.send(JSON.stringify({ ...this.last, replay: true }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async notify(event: LiveEvent | SprintEvent): Promise<void> {
    this.last = event;
    const message = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A page that went away: the next event will not try it again.
      }
    }
  }

  // Pages only listen.
  override async webSocketMessage(): Promise<void> {}

  override async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 ? 1000 : code, "");
    } catch {
      // Already closed.
    }
  }
}

export function liveFor(env: Env, cardId: number): DurableObjectStub<CardLive> | null {
  return env.CARD_LIVE ? env.CARD_LIVE.get(env.CARD_LIVE.idFromName(`card:${cardId}`)) : null;
}

// The same kind of object, one per project, for its sprint's open pages.
export function sprintLiveFor(env: Env, repo: string): DurableObjectStub<CardLive> | null {
  return env.CARD_LIVE ? env.CARD_LIVE.get(env.CARD_LIVE.idFromName(`sprint:${repo.toLowerCase()}`)) : null;
}
