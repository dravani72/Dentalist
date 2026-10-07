import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { LiveKitRtcAdapter, assertSelfHosted } from '../src/telehealth/livekit-adapter';
import { setupWorld, type World } from './helpers';

/* The LiveKit adapter without a server: what goes into join tokens and what comes out of webhooks. */

const cfg = { url: 'wss://sfu.example.test', apiUrl: 'http://127.0.0.1:1', apiKey: 'testkey', apiSecret: 'test-secret-at-least-32-characters-long' };
const adapter = new LiveKitRtcAdapter(cfg);
const room = 'rm_0123456789abcdef01234567';
const identity = '0190a1b2-0000-7000-8000-000000000001';

async function claims(token: string) {
  return new TokenVerifier(cfg.apiKey, cfg.apiSecret).verify(token);
}

async function signed(body: object, secret = cfg.apiSecret) {
  const raw = JSON.stringify(body);
  const at = new AccessToken(cfg.apiKey, secret);
  at.sha256 = createHash('sha256').update(raw).digest('base64');
  return { raw, auth: await at.toJwt() };
}

describe('LiveKit join tokens', () => {
  it('hold a waiting patient in a lobby: no publish, no subscribe, no data', async () => {
    const t = await adapter.issueToken({ room, identity, canPublish: false, canSubscribe: false, lobby: true }, 120);
    expect(t.url).toBe(cfg.url);
    const c = await claims(t.token);
    expect(c.sub).toBe(identity);
    expect(c.video).toMatchObject({ roomJoin: true, room, canPublish: false, canSubscribe: false, canPublishData: false, hidden: false, recorder: false, roomAdmin: false });
    expect(c.video?.canPublishSources ?? []).toEqual([]);
    // Nothing about the person rides in the token.
    expect(c.name ?? '').toBe('');
    expect(c.metadata ?? '').toBe('');
    expect(Number(c.exp) - Number(c.nbf ?? Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(121);
  });

  it('let an admitted participant publish camera and microphone only (no screen share)', async () => {
    const t = await adapter.issueToken({ room, identity, canPublish: true, canSubscribe: true, lobby: false }, 120);
    const c = await claims(t.token);
    expect(c.video).toMatchObject({ canPublish: true, canSubscribe: true, canPublishData: false, roomCreate: false, roomList: false, roomRecord: false });
    expect([...(c.video?.canPublishSources ?? [])].sort()).toEqual(['camera', 'microphone']);
  });
});

describe('LiveKit webhooks', () => {
  const joined = { id: 'EV_abc', event: 'participant_joined', createdAt: '1791273600', room: { name: room }, participant: { identity } };

  it('maps a verified join to a media event', async () => {
    const { raw, auth } = await signed(joined);
    expect(await adapter.receiveWebhook(raw, auth)).toEqual({ eventId: 'EV_abc', room, identity, kind: 'participant_joined', occurredAt: new Date(1791273600 * 1000).toISOString() });
  });

  it('treats an aborted connection as a leave and ignores events it does not use', async () => {
    const aborted = await signed({ ...joined, id: 'EV_ab2', event: 'participant_connection_aborted' });
    expect((await adapter.receiveWebhook(aborted.raw, aborted.auth))?.kind).toBe('participant_left');
    const track = await signed({ ...joined, id: 'EV_t', event: 'track_published' });
    expect(await adapter.receiveWebhook(track.raw, track.auth)).toBeNull();
  });

  it('rejects a missing, forged or tampered signature', async () => {
    const { raw, auth } = await signed(joined);
    await expect(adapter.receiveWebhook(raw, undefined)).rejects.toMatchObject({ status: 401 });
    const forged = await signed(joined, 'some-other-secret-that-is-long-enough!!');
    await expect(adapter.receiveWebhook(forged.raw, forged.auth)).rejects.toMatchObject({ status: 401 });
    await expect(adapter.receiveWebhook(raw.replace('participant_joined', 'participant_left'), auth)).rejects.toMatchObject({ status: 401 });
  });
});

describe('LiveKit hosting', () => {
  it('runs only self-hosted: LiveKit Cloud addresses are refused', () => {
    expect(() => new LiveKitRtcAdapter({ ...cfg, url: 'wss://practice-abc123.livekit.cloud' })).toThrow(/self-hosted/);
    expect(() => assertSelfHosted({ url: 'wss://sfu.example.test', apiUrl: 'https://PRACTICE.LIVEKIT.CLOUD' })).toThrow(/self-hosted/);
    expect(() => assertSelfHosted({ url: 'wss://livekit.cloud.example.test', apiUrl: 'http://localhost:7880' })).not.toThrow();
    expect(() => assertSelfHosted({ url: 'not a url', apiUrl: 'http://localhost:7880' })).toThrow(/valid URLs/);
  });
});

describe('LiveKit recording', () => {
  it('is unavailable, not silently on, until an egress destination is configured', async () => {
    await expect(adapter.startAudioEgress(room)).rejects.toMatchObject({ status: 503, code: 'recording_unavailable' });
  });
});

describe('LiveKit webhook endpoint', () => {
  let w: World;
  beforeAll(async () => {
    w = await setupWorld({ rtcAdapter: new LiveKitRtcAdapter(cfg) });
  });
  afterAll(async () => w?.close());

  const post = (raw: string, auth?: string) => {
    const r = w.http.post('/api/webhooks/livekit').set('Content-Type', 'application/webhook+json');
    return (auth ? r.set('Authorization', auth) : r).send(raw);
  };

  it('verifies LiveKit’s own content type against the raw body', async () => {
    const evt = { id: 'EV_route', event: 'participant_joined', createdAt: '1791273600', room: { name: room }, participant: { identity } };
    const { raw, auth } = await signed(evt);
    // Verified, then refused because this system never created that room.
    expect((await post(raw, auth)).status).toBe(404);
    expect((await post(raw)).status).toBe(401);
    expect((await post(raw.replace('EV_route', 'EV_other'), auth)).status).toBe(401);
  });

  it('acknowledges events it does not use', async () => {
    const { raw, auth } = await signed({ id: 'EV_room', event: 'room_started', room: { name: room } });
    expect((await post(raw, auth)).body).toMatchObject({ ok: true, ignored: true });
  });
});
