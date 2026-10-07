import { DynamicModule, Module, Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { APP_CONFIG, AppConfig, loadConfig } from './config';
import { DbService } from './db/db.service';
import { AuditService } from './audit/audit.service';
import { AuditController } from './audit/audit.controller';
import { AccessService } from './auth/access.service';
import { AuthService } from './auth/auth.service';
import { AuthController, DevController } from './auth/auth.controller';
import { SessionGuard } from './auth/auth.guard';
import { ErrorFilter } from './common/http';
import { FIELD_CIPHER, LocalFieldCipher, LocalRecordSigner, RECORD_SIGNER } from './crypto/keys';
import { PatientsService } from './patients/patients.service';
import { PatientsController } from './patients/patients.controller';
import { SchedulingService } from './scheduling/scheduling.service';
import { SchedulingController } from './scheduling/scheduling.controller';
import { ChartService } from './charting/chart.service';
import { SigningService } from './charting/signing.service';
import { PerioService } from './charting/perio.service';
import { ChartingController } from './charting/charting.controller';
import { LocalEncryptedStorage, MEDIA_STORAGE, MediaService } from './media/media.service';
import { MediaController } from './media/media.controller';
import { ERX_PARTNER } from './prescribing/erx-partner';
import { FakeErxPartner } from './prescribing/fake-erx-partner';
import { PrescribingService } from './prescribing/prescribing.service';
import { PrescribingController } from './prescribing/prescribing.controller';
import { LogOnlyMessageSender, MESSAGE_SENDER, OutboxWorker } from './outbox/outbox.worker';
import { TOTP_CLOCK } from './crypto/totp';
import { StaffAdminService } from './admin/staff-admin.service';
import { AccountSetupService } from './admin/account-setup.service';
import { AccountSetupController, StaffAdminController } from './admin/staff-admin.controller';
import { CLEARINGHOUSE } from './billing/clearinghouse';
import { FakeClearinghouse } from './billing/fake-clearinghouse';
import { BillingService } from './billing/billing.service';
import { ClaimsService } from './billing/claims.service';
import { BillingController } from './billing/billing.controller';
import { PortalAudit } from './portal/portal-audit';
import { PortalAuthService } from './portal/portal-auth.service';
import { PortalGuard } from './portal/portal-actor';
import { PortalService } from './portal/portal.service';
import { PortalStaffService } from './portal/portal-staff.service';
import { PortalAuthController, PortalController, PortalDevController, PortalStaffController } from './portal/portal.controller';
import { FakeRtcAdapter, RTC_ADAPTER } from './telehealth/rtc-adapter';
import { LiveKitRtcAdapter } from './telehealth/livekit-adapter';
import { EligibilityService } from './telehealth/eligibility.service';
import { TelehealthService } from './telehealth/telehealth.service';
import { TelehealthPortalService } from './telehealth/telehealth-portal.service';
import { PortalTelehealthController, RtcSimController, RtcWebhookController, TelehealthController } from './telehealth/telehealth.controller';

export interface AppOverrides {
  config?: Partial<AppConfig>;
  erxPartner?: unknown;
  messageSender?: unknown;
  clearinghouse?: unknown;
  /** Media server for telehealth video (tests pass their own sandbox to drive it). */
  rtcAdapter?: unknown;
  /** Clock for authenticator checks (tests only). */
  totpClock?: (userId: string) => number;
}

/**
 * One deployable, many modules (architecture plan): each bounded context keeps its own
 * service, controller and tables; they share only the database service, audit and access checks.
 * Vendor-facing pieces (KMS, S3, eRx partner, messaging) are injected behind interfaces.
 */
@Module({})
export class AppModule {
  static register(overrides: AppOverrides = {}): DynamicModule {
    const config = { ...loadConfig(), ...overrides.config };
    const cipher = new LocalFieldCipher(config.localKeyDir);
    if (process.env.NODE_ENV === 'production' && config.rtcProvider === 'livekit' && config.livekit.apiSecret === 'secret') {
      throw new Error('LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set in production');
    }
    const rtc = overrides.rtcAdapter ?? (config.rtcProvider === 'livekit' ? new LiveKitRtcAdapter(config.livekit) : new FakeRtcAdapter());
    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: FIELD_CIPHER, useValue: cipher },
      { provide: RECORD_SIGNER, useValue: new LocalRecordSigner(config.localKeyDir) },
      { provide: MEDIA_STORAGE, useValue: new LocalEncryptedStorage(config.localMediaDir, cipher) },
      { provide: ERX_PARTNER, useValue: overrides.erxPartner ?? new FakeErxPartner() },
      { provide: CLEARINGHOUSE, useValue: overrides.clearinghouse ?? new FakeClearinghouse() },
      { provide: RTC_ADAPTER, useValue: rtc },
      { provide: MESSAGE_SENDER, useValue: overrides.messageSender ?? new LogOnlyMessageSender() },
      { provide: TOTP_CLOCK, useValue: overrides.totpClock ?? ((_userId: string) => Date.now()) },
      { provide: APP_GUARD, useClass: SessionGuard },
      { provide: APP_FILTER, useClass: ErrorFilter },
      DbService,
      AuditService,
      AccessService,
      AuthService,
      PatientsService,
      SchedulingService,
      ChartService,
      SigningService,
      PerioService,
      MediaService,
      PrescribingService,
      BillingService,
      ClaimsService,
      OutboxWorker,
      PortalAudit,
      PortalAuthService,
      PortalGuard,
      PortalService,
      PortalStaffService,
      StaffAdminService,
      AccountSetupService,
      EligibilityService,
      TelehealthService,
      TelehealthPortalService,
    ];
    const devTools = config.devTools && process.env.NODE_ENV !== 'production';
    // The browser stand-in exists only with the sandbox media server, and never in production.
    const rtcSim = rtc instanceof FakeRtcAdapter && process.env.NODE_ENV !== 'production';
    return {
      module: AppModule,
      controllers: [
        AuthController,
        PatientsController,
        SchedulingController,
        ChartingController,
        MediaController,
        PrescribingController,
        AuditController,
        BillingController,
        PortalAuthController,
        PortalController,
        PortalStaffController,
        StaffAdminController,
        AccountSetupController,
        TelehealthController,
        RtcWebhookController,
        PortalTelehealthController,
        ...(rtcSim ? [RtcSimController] : []),
        ...(devTools ? [DevController, PortalDevController] : []),
      ],
      providers,
    };
  }
}
