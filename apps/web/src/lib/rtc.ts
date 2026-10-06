/**
 * Browser side of the media connection. With LiveKit, `VideoStage` connects with the server-issued
 * token. With the development sandbox (no audio or video), "joining" hands the token to the API's
 * stand-in media server, exactly as a real SFU client would.
 */
export interface JoinToken {
  token: string;
  url: string;
  expiresAt: string;
  lobby?: boolean;
}

async function sim(path: 'connect' | 'disconnect' | 'state', token: string) {
  const res = await fetch(`/api/rtc-sim/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!res.ok) throw new Error(res.status === 404 ? 'The sandbox media server is not available here' : 'The media server refused the connection');
  return res.json() as Promise<Record<string, unknown>>;
}

export const isSandbox = (t: JoinToken) => t.url.startsWith('sandbox://');
/** LiveKit connects inside VideoStage; only the sandbox needs an explicit connect call. */
export const rtcJoin = async (t: JoinToken) => (isSandbox(t) ? sim('connect', t.token) : {});
export const rtcLeave = async (t: JoinToken) => (isSandbox(t) ? sim('disconnect', t.token).catch(() => undefined) : undefined);
export const rtcState = (t: JoinToken) => sim('state', t.token) as Promise<{ connected: boolean; grant: { lobby: boolean; canPublish: boolean } | null }>;

/**
 * A deliberately captured still frame for the sandbox, which has no camera: draws a labeled synthetic
 * frame. With LiveKit, VideoStage grabs the patient's current video frame instead. PNG only.
 */
export function captureSyntheticFrame(label: string): { dataBase64: string; frameAt: string } {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 200;
  const g = c.getContext('2d')!;
  g.fillStyle = '#2b2b2b';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#ddd';
  for (let x = 0; x < c.width; x += 16) g.strokeRect(x, 0, 8, c.height);
  g.fillStyle = '#fff';
  g.font = '16px sans-serif';
  const frameAt = new Date().toISOString();
  g.fillText('SYNTHETIC FRAME', 12, 28);
  g.fillText(label.slice(0, 32), 12, 54);
  g.fillText(frameAt.slice(0, 19).replace('T', ' '), 12, 80);
  return { dataBase64: c.toDataURL('image/png').split(',')[1]!, frameAt };
}
