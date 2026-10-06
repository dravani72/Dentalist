import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Real-time media boundary (handoff: RTC, consent, media and operational security). A
 * LiveKit-compatible SFU sits behind this interface in production, after the BAA and service
 * scope are confirmed; core code never sees vendor payloads or SDK types.
 *
 * Grants are derived by the server from the database, never from what a browser asks for. There is
 * deliberately no way to request room admin, room list, room create or recording grants for a
 * browser, and no video egress at all: the only egress is audio-only.
 */
export interface RtcGrant {
  room: string;
  /** Opaque participant id (telehealth_participant.id). Never a name or patient detail. */
  identity: string;
  canPublish: boolean;
  canSubscribe: boolean;
  /** A waiting patient is held in a restricted lobby: no publish, no subscribe. */
  lobby: boolean;
}

export interface RtcAdapter {
  readonly name: string;
  createRoom(room: string): Promise<void>;
  /** A short-lived signed token scoped to one room, one identity and these grants only. */
  issueToken(grant: RtcGrant, ttlSeconds: number): Promise<{ token: string; url: string; expiresAt: string }>;
  /** Server-side removal: an already-joined client is disconnected now, not when its token expires. */
  removeParticipant(room: string, identity: string): Promise<void>;
  updateGrant(room: string, identity: string, grant: Pick<RtcGrant, 'canPublish' | 'canSubscribe' | 'lobby'>): Promise<void>;
  deleteRoom(room: string): Promise<void>;
  /** Audio-only egress of the room's human participants. Video selectors do not exist on this interface. */
  startAudioEgress(room: string): Promise<{ egressId: string }>;
  stopEgress(egressId: string): Promise<void>;
}

export const RTC_ADAPTER = Symbol('RTC_ADAPTER');

/** Events the media server reports back (via the signed webhook). */
export interface RtcEvent {
  eventId: string;
  room: string;
  identity: string;
  kind: 'participant_joined' | 'participant_left' | 'participant_reconnecting';
  occurredAt: string;
}

/**
 * Stand-in media server for development and tests. It validates tokens like an SFU would,
 * keeps rooms and participants in memory, and reports joins and leaves through the same signed
 * webhook path production uses. It carries no audio or video. Egress records only which track
 * kinds it would capture, so tests can prove zero video tracks.
 */
export class FakeRtcAdapter implements RtcAdapter {
  readonly name = 'sandbox-sfu';
  private readonly key = randomBytes(32);
  readonly rooms = new Map<string, Map<string, RtcGrant>>();
  readonly egress = new Map<string, { room: string; trackKinds: ('audio' | 'video')[]; stopped: boolean }>();
  /** Set by main.ts: delivers events to the webhook handler as the vendor would. */
  callback?: (evt: RtcEvent) => Promise<void>;

  async createRoom(room: string) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Map());
  }

  async issueToken(grant: RtcGrant, ttlSeconds: number) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const body = Buffer.from(JSON.stringify({ ...grant, exp, jti: randomUUID() })).toString('base64url');
    const sig = createHmac('sha256', this.key).update(body).digest('base64url');
    return { token: `${body}.${sig}`, url: 'sandbox://sfu', expiresAt: new Date(exp * 1000).toISOString() };
  }

  /** What the SFU would do with a token: verify signature and expiry, nothing else is trusted. */
  verify(token: string): (RtcGrant & { exp: number }) | null {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = createHmac('sha256', this.key).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const g = JSON.parse(Buffer.from(body, 'base64url').toString()) as RtcGrant & { exp: number };
    if (g.exp < Date.now() / 1000) return null;
    return g;
  }

  /** Simulated client connect: the SFU admits the identity with the token's grants and reports it. */
  async connect(token: string): Promise<RtcGrant | null> {
    const g = this.verify(token);
    if (!g || !this.rooms.has(g.room)) return null;
    this.rooms.get(g.room)!.set(g.identity, { room: g.room, identity: g.identity, canPublish: g.canPublish, canSubscribe: g.canSubscribe, lobby: g.lobby });
    await this.emit(g.room, g.identity, 'participant_joined');
    return g;
  }

  async disconnect(token: string): Promise<boolean> {
    const g = this.verify(token);
    if (!g) return false;
    const room = this.rooms.get(g.room);
    if (!room?.delete(g.identity)) return false;
    await this.emit(g.room, g.identity, 'participant_left');
    return true;
  }

  isConnected(room: string, identity: string) {
    return this.rooms.get(room)?.has(identity) ?? false;
  }

  grantOf(room: string, identity: string) {
    return this.rooms.get(room)?.get(identity);
  }

  async removeParticipant(room: string, identity: string) {
    if (this.rooms.get(room)?.delete(identity)) await this.emit(room, identity, 'participant_left');
  }

  async updateGrant(room: string, identity: string, grant: Pick<RtcGrant, 'canPublish' | 'canSubscribe' | 'lobby'>) {
    const cur = this.rooms.get(room)?.get(identity);
    if (cur) Object.assign(cur, grant);
  }

  async deleteRoom(room: string) {
    const r = this.rooms.get(room);
    if (!r) return;
    for (const identity of [...r.keys()]) await this.removeParticipant(room, identity);
    for (const e of this.egress.values()) if (e.room === room) e.stopped = true;
    this.rooms.delete(room);
  }

  async startAudioEgress(room: string) {
    const egressId = `EG_${randomUUID()}`;
    this.egress.set(egressId, { room, trackKinds: ['audio'], stopped: false });
    return { egressId };
  }

  async stopEgress(egressId: string) {
    const e = this.egress.get(egressId);
    if (e) e.stopped = true;
  }

  private async emit(room: string, identity: string, kind: RtcEvent['kind']) {
    await this.callback?.({ eventId: `EV_${randomUUID()}`, room, identity, kind, occurredAt: new Date().toISOString() });
  }
}
