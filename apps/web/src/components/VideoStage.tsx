import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { LiveKitRoom, RoomAudioRenderer, VideoTrack, isTrackReference, useConnectionState, useLocalParticipant, useRoomContext, useTracks } from '@livekit/components-react';
import { ConnectionState, ParticipantEvent, Track, setLogLevel } from 'livekit-client';
import { Status } from '../pages/portal/ui';
import { isSandbox, type JoinToken } from '../lib/rtc';

// The SDK's own logging stays at errors only: participant ids are opaque, but nothing chatty reaches the console.
setLogLevel('error');

export type Frame = { dataBase64: string; frameAt: string };
export type CaptureFn = () => Frame | null;

interface Props {
  token: JoinToken;
  /** Display labels by participant identity (the opaque participant id). */
  labels?: Record<string, string>;
  /** Fallback label for someone not in `labels`. */
  otherLabel?: string;
  onLobby?: (lobby: boolean) => void;
  onLeft?: () => void;
  /** Filled with a function that grabs a PNG of the first remote camera, for deliberate snapshots. */
  captureRef?: MutableRefObject<CaptureFn | null>;
}

/**
 * The video area. With the development sandbox it shows a placeholder (no media); with LiveKit it
 * connects with the server-issued token and shows camera tiles. Camera and microphone are turned on
 * only once the server has let this person out of the lobby.
 */
export function VideoStage(p: Props) {
  if (isSandbox(p.token)) {
    return (
      <div className="xray" role="img" aria-label="Video area (sandbox: no camera)" style={{ minHeight: 160, display: 'grid', placeItems: 'center' }}>
        <span className="muted">Connected to the sandbox media server (no audio or video in development)</span>
      </div>
    );
  }
  return (
    <LiveKitRoom serverUrl={p.token.url} token={p.token.token} connect audio={false} video={false} options={{ adaptiveStream: true, dynacast: true }} onDisconnected={p.onLeft}>
      <Stage {...p} />
      <RoomAudioRenderer />
    </LiveKitRoom>
  );
}

function Stage({ labels = {}, otherLabel = 'Participant', onLobby, captureRef }: Props) {
  const room = useRoomContext();
  const state = useConnectionState();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } = useLocalParticipant();
  const [perm, setPerm] = useState(() => ({ pub: !!localParticipant.permissions?.canPublish, sub: !!localParticipant.permissions?.canSubscribe }));
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const read = () => setPerm({ pub: !!localParticipant.permissions?.canPublish, sub: !!localParticipant.permissions?.canSubscribe });
    read();
    localParticipant.on(ParticipantEvent.ParticipantPermissionsChanged, read);
    return () => void localParticipant.off(ParticipantEvent.ParticipantPermissionsChanged, read);
  }, [localParticipant, state]);

  const lobby = state === ConnectionState.Connected && !perm.sub;
  useEffect(() => {
    if (state === ConnectionState.Connected) onLobby?.(lobby);
  }, [lobby, state, onLobby]);

  // Publish only once the server allows it. A blocked camera still lets the visit go ahead by audio.
  useEffect(() => {
    if (state !== ConnectionState.Connected || !perm.pub) return;
    let cancelled = false;
    void (async () => {
      const problems: string[] = [];
      await room.localParticipant.setMicrophoneEnabled(true).catch(() => problems.push('microphone'));
      await room.localParticipant.setCameraEnabled(true).catch(() => problems.push('camera'));
      if (!cancelled) setDeviceError(problems.length ? `Your ${problems.join(' and ')} could not be turned on. Allow access in the browser, or continue without it.` : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [state, perm.pub, room]);

  const tracks = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], { onlySubscribed: false });
  const remote = tracks.filter((t) => !t.participant.isLocal);
  const local = tracks.find((t) => t.participant.isLocal);

  useEffect(() => {
    if (!captureRef) return;
    captureRef.current = () => {
      const v = box.current?.querySelector<HTMLVideoElement>('[data-remote="1"] video');
      if (!v || !v.videoWidth) return null;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext('2d')!.drawImage(v, 0, 0);
      return { dataBase64: c.toDataURL('image/png').split(',')[1]!, frameAt: new Date().toISOString() };
    };
    return () => {
      captureRef.current = null;
    };
  }, [captureRef]);

  return (
    <div className="video-stage" ref={box}>
      <div className="row">
        {state === ConnectionState.Connected ? <Status kind="ok">Video connected</Status>
          : state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting ? <Status kind="progress">Reconnecting…</Status>
          : state === ConnectionState.Connecting ? <Status kind="wait">Connecting…</Status>
          : <Status kind="no">Not connected</Status>}
        {perm.pub && (isMicrophoneEnabled ? <Status kind="ok">Microphone on</Status> : <Status kind="no">Microphone off</Status>)}
        {perm.pub && (isCameraEnabled ? <Status kind="ok">Camera on</Status> : <Status kind="no">Camera off</Status>)}
      </div>
      {deviceError && <p className="small" role="alert">⚠ {deviceError}</p>}
      {lobby ? (
        <div className="xray video-wait" role="status">
          <span>○ Waiting to be let in. Your camera and microphone stay off until then.</span>
        </div>
      ) : (
        <div className="video-grid">
          {remote.length === 0 && (
            <div className="xray video-wait">
              <span>○ Waiting for others to join</span>
            </div>
          )}
          {remote.map((t) => (
            <figure key={t.participant.identity} className="video-tile" data-remote="1">
              {isTrackReference(t) && !t.publication.isMuted ? <VideoTrack trackRef={t} /> : <div className="video-off">Camera off</div>}
              <figcaption>
                {labels[t.participant.identity] ?? otherLabel}
                {!t.participant.isMicrophoneEnabled && ' · microphone off'}
              </figcaption>
            </figure>
          ))}
          {local && (
            <figure className="video-tile self">
              {isTrackReference(local) && !local.publication.isMuted ? <VideoTrack trackRef={local} /> : <div className="video-off">Your camera is off</div>}
              <figcaption>You</figcaption>
            </figure>
          )}
        </div>
      )}
      {perm.pub && (
        <div className="row">
          <button type="button" className="btn small" onClick={() => void room.localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled).catch(() => setDeviceError('The microphone could not be changed.'))}>
            {isMicrophoneEnabled ? 'Mute microphone' : 'Unmute microphone'}
          </button>
          <button type="button" className="btn small" onClick={() => void room.localParticipant.setCameraEnabled(!isCameraEnabled).catch(() => setDeviceError('The camera could not be changed.'))}>
            {isCameraEnabled ? 'Turn camera off' : 'Turn camera on'}
          </button>
        </div>
      )}
    </div>
  );
}
