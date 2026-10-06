import path from 'node:path';

/** Runtime configuration. Every value has a local-development default; production sets all of them. */
export interface AppConfig {
  databaseUrl: string;
  databaseOwnerUrl: string;
  port: number;
  devTools: boolean;
  localKeyDir: string;
  localMediaDir: string;
  erxWebhookSecret: string;
  /** Shared secret the media server signs its webhook calls with. */
  rtcWebhookSecret: string;
  sessionIdleMinutes: number;
  sessionAbsoluteHours: number;
  breakGlassMinutes: number;
  /** How long after a claim is accepted to look for its remittance (then again, bounded). */
  claimPollSeconds: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const root = path.resolve(__dirname, '..');
  return {
    databaseUrl: env.DATABASE_URL ?? 'postgres://teeth_app:teeth_app_dev@localhost:5432/teeth',
    databaseOwnerUrl: env.DATABASE_OWNER_URL ?? 'postgres://teeth_owner:teeth_owner_dev@localhost:5432/teeth',
    port: Number(env.PORT ?? 3000),
    devTools: env.DEV_TOOLS === '1',
    localKeyDir: path.resolve(root, env.LOCAL_KEY_DIR ?? 'var/keys'),
    localMediaDir: path.resolve(root, env.LOCAL_MEDIA_DIR ?? 'var/media'),
    erxWebhookSecret: env.ERX_WEBHOOK_SECRET ?? 'dev-webhook-secret',
    rtcWebhookSecret: env.RTC_WEBHOOK_SECRET ?? 'dev-rtc-webhook-secret',
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 15),
    sessionAbsoluteHours: Number(env.SESSION_ABSOLUTE_HOURS ?? 12),
    breakGlassMinutes: Number(env.BREAK_GLASS_MINUTES ?? 60),
    claimPollSeconds: Number(env.CLAIM_POLL_SECONDS ?? 1800),
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
