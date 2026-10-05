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
import { ChartingController } from './charting/charting.controller';
import { LocalEncryptedStorage, MEDIA_STORAGE, MediaService } from './media/media.service';
import { MediaController } from './media/media.controller';
import { ERX_PARTNER } from './prescribing/erx-partner';
import { FakeErxPartner } from './prescribing/fake-erx-partner';
import { PrescribingService } from './prescribing/prescribing.service';
import { PrescribingController } from './prescribing/prescribing.controller';
import { LogOnlyMessageSender, MESSAGE_SENDER, OutboxWorker } from './outbox/outbox.worker';
import { PortalAudit } from './portal/portal-audit';
import { PortalAuthService } from './portal/portal-auth.service';
import { PortalGuard } from './portal/portal-actor';
import { PortalService } from './portal/portal.service';
import { PortalStaffService } from './portal/portal-staff.service';
import { PortalAuthController, PortalController, PortalDevController, PortalStaffController } from './portal/portal.controller';

export interface AppOverrides {
  config?: Partial<AppConfig>;
  erxPartner?: unknown;
  messageSender?: unknown;
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
    const providers: Provider[] = [
      { provide: APP_CONFIG, useValue: config },
      { provide: FIELD_CIPHER, useValue: cipher },
      { provide: RECORD_SIGNER, useValue: new LocalRecordSigner(config.localKeyDir) },
      { provide: MEDIA_STORAGE, useValue: new LocalEncryptedStorage(config.localMediaDir, cipher) },
      { provide: ERX_PARTNER, useValue: overrides.erxPartner ?? new FakeErxPartner() },
      { provide: MESSAGE_SENDER, useValue: overrides.messageSender ?? new LogOnlyMessageSender() },
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
      MediaService,
      PrescribingService,
      OutboxWorker,
      PortalAudit,
      PortalAuthService,
      PortalGuard,
      PortalService,
      PortalStaffService,
    ];
    const devTools = config.devTools && process.env.NODE_ENV !== 'production';
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
        PortalAuthController,
        PortalController,
        PortalStaffController,
        ...(devTools ? [DevController, PortalDevController] : []),
      ],
      providers,
    };
  }
}
