import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
  type ParticipantPermission,
  type VideoGrant,
} from 'livekit-server-sdk';
import { DomainError } from '../common/errors';
import type { RtcAdapter, RtcEvent, RtcGrant } from './rtc-adapter';

export interface LiveKitConfig {
  /** What browsers connect to (wss://… in production). */
  url: string;
  /** Server API base the backend calls (https://… or http://localhost:7880 in development). */
  apiUrl: string;
  apiKey: string;
  apiSecret: string;
  /**
   * Where the egress service writes audio files, for example `/recordings/{room_name}-{time}.ogg` on an
   * encrypted volume the practice controls. Unset means recording is unavailable, never silently on.
   */
  egressFilepath?: string;
}

/** Only camera and microphone; no screen share, so nothing else on a device can be shown or captured. */
const SOURCES = [TrackSource.CAMERA, TrackSource.MICROPHONE];

function permission(g: Pick<RtcGrant, 'canPublish' | 'canSubscribe' | 'lobby'>): Partial<ParticipantPermission> {
  const open = !g.lobby;
  return {
    canPublish: open && g.canPublish,
    canSubscribe: open && g.canSubscribe,
    canPublishData: false,
    canPublishSources: open && g.canPublish ? SOURCES : [],
    canUpdateMetadata: false,
    hidden: false,
    recorder: false,
  };
}

/**
 * LiveKit (the SFU the Telorovia application uses) behind the core media boundary. Run self-hosted, it
 * adds no vendor: media stays on infrastructure the practice operates. LiveKit Cloud would be a new
 * PHI subprocessor and needs a trust-boundary and BAA review before use (AGENTS.md).
 *
 * Grants come from the database through the service, never from the browser. Tokens carry only the
 * room name and the opaque participant id: no name, email or metadata. There is no data channel
 * (chat), no screen share, no hidden participant, and the only egress is audio.
 */
export class LiveKitRtcAdapter implements RtcAdapter {
  readonly name = 'livekit';
  private readonly rooms: RoomServiceClient;
  private readonly egress: EgressClient;
  private readonly webhooks: WebhookReceiver;

  constructor(private readonly cfg: LiveKitConfig) {
    this.rooms = new RoomServiceClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret);
    this.egress = new EgressClient(cfg.apiUrl, cfg.apiKey, cfg.apiSecret);
    this.webhooks = new WebhookReceiver(cfg.apiKey, cfg.apiSecret);
  }

  async createRoom(room: string) {
    // Rooms close soon after everyone leaves; maxParticipants allows patient, guardian, interpreter, dentist, coordinator.
    await this.rooms.createRoom({ name: room, emptyTimeout: 300, departureTimeout: 60, maxParticipants: 6 });
  }

  async issueToken(grant: RtcGrant, ttlSeconds: number) {
    const at = new AccessToken(this.cfg.apiKey, this.cfg.apiSecret, { identity: grant.identity, ttl: ttlSeconds });
    const p = permission(grant);
    const video: VideoGrant = {
      roomJoin: true,
      room: grant.room,
      canPublish: p.canPublish,
      canSubscribe: p.canSubscribe,
      canPublishData: false,
      canPublishSources: p.canPublishSources,
      canUpdateOwnMetadata: false,
      hidden: false,
      recorder: false,
      roomAdmin: false,
      roomCreate: false,
      roomList: false,
      roomRecord: false,
    };
    at.addGrant(video);
    const token = await at.toJwt();
    return { token, url: this.cfg.url, expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString() };
  }

  async removeParticipant(room: string, identity: string) {
    await this.ignoreMissing(() => this.rooms.removeParticipant(room, identity));
  }

  async updateGrant(room: string, identity: string, grant: Pick<RtcGrant, 'canPublish' | 'canSubscribe' | 'lobby'>) {
    await this.ignoreMissing(() => this.rooms.updateParticipant(room, identity, { permission: permission(grant) }));
  }

  async deleteRoom(room: string) {
    await this.ignoreMissing(() => this.rooms.deleteRoom(room));
  }

  async startAudioEgress(room: string) {
    if (!this.cfg.egressFilepath) {
      throw new DomainError(503, 'recording_unavailable', 'Audio recording is not set up for this practice. The visit can continue unrecorded.');
    }
    const output = new EncodedFileOutput({ fileType: EncodedFileType.OGG, filepath: this.cfg.egressFilepath });
    const info = await this.egress.startRoomCompositeEgress(room, { file: output }, { audioOnly: true });
    return { egressId: info.egressId };
  }

  async stopEgress(egressId: string) {
    await this.ignoreMissing(() => this.egress.stopEgress(egressId));
  }

  /**
   * Verifies a LiveKit webhook (a JWT signed with the API secret that carries the body's SHA-256) and
   * maps the events the service cares about. Anything else is acknowledged and ignored.
   */
  async receiveWebhook(rawBody: string, authHeader: string | undefined): Promise<RtcEvent | null> {
    if (!authHeader) throw new DomainError(401, 'unauthenticated', 'Missing signature');
    const evt = await this.webhooks.receive(rawBody, authHeader).catch(() => {
      throw new DomainError(401, 'unauthenticated', 'Bad signature');
    });
    const kind =
      evt.event === 'participant_joined' ? 'participant_joined'
      : evt.event === 'participant_left' || evt.event === 'participant_connection_aborted' ? 'participant_left'
      : null;
    if (!kind || !evt.room?.name || !evt.participant?.identity) return null;
    const seconds = Number(evt.createdAt ?? 0n);
    return {
      eventId: evt.id,
      room: evt.room.name,
      identity: evt.participant.identity,
      kind,
      occurredAt: new Date(seconds > 0 ? seconds * 1000 : Date.now()).toISOString(),
    };
  }

  /** Removing someone already gone, or a room LiveKit already closed, is success. */
  private async ignoreMissing(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      const status = (err as { status?: number; code?: string }).status;
      const code = (err as { code?: string }).code;
      if (status === 404 || code === 'not_found') return;
      throw err;
    }
  }
}
