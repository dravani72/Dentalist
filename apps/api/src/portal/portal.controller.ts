import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  CommPreferenceRequest,
  ConsentDeclineRequest,
  ConsentRevokeRequest,
  ConsentSendRequest,
  ConsentSignRequest,
  ConsentTemplateRequest,
  GrantRevokeRequest,
  PharmacyPreferenceRequest,
  PortalAcceptRequest,
  PortalBookingRequest,
  PortalInvitationRequest,
  PortalLoginStart,
  PortalLoginVerify,
  PortalMessageRequest,
  PortalReplyRequest,
  PortalRequestCreate,
  PortalRequestStatusChange,
  StaffThreadRequest,
} from '@teeth/shared';
import { body } from '../common/http';
import { notFound } from '../common/errors';
import { CurrentActor, Public } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { CurrentPortalActor, PortalActor, PortalGuard } from './portal-actor';
import { PortalAuthService } from './portal-auth.service';
import { PortalService } from './portal.service';
import { PortalStaffService } from './portal-staff.service';

type Infer<T extends z.ZodTypeAny> = z.infer<T>;

/** Sign-in for patients and representatives. Public to both guards; rate-limited at the edge in production. */
@Public()
@Controller('portal/auth')
export class PortalAuthController {
  constructor(@Inject(PortalAuthService) private readonly auth: PortalAuthService) {}

  @Post('accept-invitation')
  accept(@Body(body(PortalAcceptRequest)) req: Infer<typeof PortalAcceptRequest>) {
    return this.auth.acceptInvitation(req);
  }

  @Post('start')
  start(@Body(body(PortalLoginStart)) req: Infer<typeof PortalLoginStart>) {
    return this.auth.start(req);
  }

  @Post('verify')
  verify(@Body(body(PortalLoginVerify)) req: Infer<typeof PortalLoginVerify>) {
    return this.auth.verify(req);
  }
}

/**
 * Everything a signed-in portal user does. @Public() only opts out of the workforce guard;
 * PortalGuard then requires a portal session, so a staff token cannot be used here and a portal
 * token cannot be used on staff routes.
 */
@Public()
@UseGuards(PortalGuard)
@Controller('portal')
export class PortalController {
  constructor(
    @Inject(PortalService) private readonly portal: PortalService,
    @Inject(PortalAuthService) private readonly auth: PortalAuthService,
  ) {}

  @Get('me')
  me(@CurrentPortalActor() a: PortalActor) {
    return this.portal.me(a);
  }

  @Post('logout')
  logout(@CurrentPortalActor() a: PortalActor) {
    return this.auth.logout(a);
  }

  @Get('patients/:pid/appointments')
  appointments(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.appointments(a, pid);
  }

  @Post('patients/:pid/appointments/:id/confirm')
  confirm(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.confirmAppointment(a, pid, id);
  }

  @Get('patients/:pid/booking/types')
  bookableTypes(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.bookableTypes(a, pid);
  }

  @Get('patients/:pid/booking/slots')
  slots(
    @CurrentPortalActor() a: PortalActor,
    @Param('pid', ParseUUIDPipe) pid: string,
    @Query('typeId', ParseUUIDPipe) typeId: string,
    @Query('locationId', ParseUUIDPipe) locationId: string,
  ) {
    return this.portal.openSlots(a, pid, typeId, locationId).then(({ timeZone, slots }) => ({ timeZone, slots }));
  }

  @Post('booking')
  book(@CurrentPortalActor() a: PortalActor, @Body(body(PortalBookingRequest)) req: Infer<typeof PortalBookingRequest>) {
    return this.portal.book(a, req);
  }

  @Get('patients/:pid/visits')
  visits(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.visits(a, pid);
  }

  @Get('patients/:pid/visits/:id')
  visit(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.visit(a, pid, id);
  }

  @Get('patients/:pid/treatment-plan')
  plan(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.treatmentPlan(a, pid);
  }

  @Get('patients/:pid/billing')
  billing(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.billing(a, pid);
  }

  @Get('patients/:pid/health')
  health(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.health(a, pid);
  }

  @Get('patients/:pid/prescriptions')
  prescriptions(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.prescriptions(a, pid);
  }

  @Get('patients/:pid/pharmacies')
  pharmacies(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.pharmacies(a, pid);
  }

  @Get('patients/:pid/pharmacy-search')
  searchPharmacies(
    @CurrentPortalActor() a: PortalActor,
    @Param('pid', ParseUUIDPipe) pid: string,
    @Query('name') name?: string,
    @Query('zip') zip?: string,
    @Query('open24h') open24h?: string,
  ) {
    return this.portal.searchPharmacies(a, pid, { name: name || undefined, zip: zip || undefined, open24h: open24h === 'true' || undefined });
  }

  @Post('patients/:pid/pharmacies')
  setPharmacy(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string, @Body(body(PharmacyPreferenceRequest)) req: Infer<typeof PharmacyPreferenceRequest>) {
    return this.portal.setPharmacy(a, pid, req);
  }

  @Post('patients/:pid/pharmacies/:prefId/remove')
  removePharmacy(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string, @Param('prefId', ParseUUIDPipe) prefId: string) {
    return this.portal.removePharmacy(a, pid, prefId);
  }

  @Get('patients/:pid/threads')
  threads(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.threads(a, pid);
  }

  @Post('threads')
  startThread(@CurrentPortalActor() a: PortalActor, @Body(body(PortalMessageRequest)) req: Infer<typeof PortalMessageRequest>) {
    return this.portal.startThread(a, req);
  }

  @Get('threads/:id')
  thread(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.thread(a, id);
  }

  @Post('threads/:id/reply')
  reply(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PortalReplyRequest)) req: Infer<typeof PortalReplyRequest>) {
    return this.portal.reply(a, id, req.body);
  }

  @Get('patients/:pid/requests')
  requests(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.requests(a, pid);
  }

  @Post('requests')
  createRequest(@CurrentPortalActor() a: PortalActor, @Body(body(PortalRequestCreate)) req: PortalRequestCreate) {
    return this.portal.createRequest(a, req);
  }

  @Get('patients/:pid/consents')
  consents(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.consents(a, pid);
  }

  @Get('consents/:id')
  consent(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.portal.consent(a, id);
  }

  @Post('consents/:id/sign')
  sign(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ConsentSignRequest)) req: Infer<typeof ConsentSignRequest>) {
    return this.portal.signConsent(a, id, req);
  }

  @Post('consents/:id/decline')
  decline(@CurrentPortalActor() a: PortalActor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ConsentDeclineRequest)) req: Infer<typeof ConsentDeclineRequest>) {
    return this.portal.declineConsent(a, id, req);
  }

  @Get('patients/:pid/preferences')
  preferences(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string) {
    return this.portal.preferences(a, pid);
  }

  @Post('patients/:pid/preferences')
  setPreferences(@CurrentPortalActor() a: PortalActor, @Param('pid', ParseUUIDPipe) pid: string, @Body(body(CommPreferenceRequest)) req: Infer<typeof CommPreferenceRequest>) {
    return this.portal.setPreferences(a, pid, req);
  }
}

/** Practice-side portal management, behind the normal workforce session. */
@Controller()
export class PortalStaffController {
  constructor(@Inject(PortalStaffService) private readonly staff: PortalStaffService) {}

  @Get('patients/:id/portal')
  patientPortal(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.patientPortal(actor, id);
  }

  @Post('patients/:id/portal/invitations')
  invite(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PortalInvitationRequest)) req: Infer<typeof PortalInvitationRequest>) {
    return this.staff.invite(actor, id, req);
  }

  @Post('portal-invitations/:id/revoke')
  revokeInvitation(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.revokeInvitation(actor, id);
  }

  @Post('portal-grants/:id/revoke')
  revokeGrant(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(GrantRevokeRequest)) req: Infer<typeof GrantRevokeRequest>) {
    return this.staff.revokeGrant(actor, id, req);
  }

  @Get('portal-inbox')
  inbox(@CurrentActor() actor: Actor) {
    return this.staff.inbox(actor);
  }

  @Get('portal-threads/:id')
  thread(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.thread(actor, id);
  }

  @Post('portal-threads/:id/reply')
  reply(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PortalReplyRequest)) req: Infer<typeof PortalReplyRequest>) {
    return this.staff.reply(actor, id, req.body);
  }

  @Post('portal-threads/:id/close')
  close(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.closeThread(actor, id);
  }

  @Post('patients/:id/portal/threads')
  startThread(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(StaffThreadRequest)) req: Infer<typeof StaffThreadRequest>) {
    return this.staff.startThread(actor, id, req);
  }

  @Post('portal-requests/:id/status')
  requestStatus(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PortalRequestStatusChange)) req: Infer<typeof PortalRequestStatusChange>) {
    return this.staff.setRequestStatus(actor, id, req);
  }

  @Get('consent-templates')
  templates(@CurrentActor() actor: Actor) {
    return this.staff.templates(actor);
  }

  @Post('consent-templates')
  saveTemplate(@CurrentActor() actor: Actor, @Body(body(ConsentTemplateRequest)) req: Infer<typeof ConsentTemplateRequest>) {
    return this.staff.saveTemplate(actor, req);
  }

  @Post('patients/:id/consent-requests')
  sendConsent(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ConsentSendRequest)) req: Infer<typeof ConsentSendRequest>) {
    return this.staff.sendConsent(actor, id, req);
  }

  @Post('consent-requests/:id/cancel')
  cancelConsent(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.cancelConsent(actor, id);
  }

  @Get('consent-signatures/:id')
  signedCopy(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.staff.signedCopy(actor, id);
  }

  @Post('consent-signatures/:id/revoke')
  revokeSignature(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ConsentRevokeRequest)) req: Infer<typeof ConsentRevokeRequest>) {
    return this.staff.revokeSignature(actor, id, req);
  }
}

/** Development only (DEV_TOOLS=1): the last sign-in code emailed to a synthetic (.test) address. */
@Public()
@Controller('dev')
export class PortalDevController {
  constructor(@Inject(PortalAuthService) private readonly auth: PortalAuthService) {}

  @Get('portal-code')
  code(@Query('email') email: string) {
    if (!email || !email.toLowerCase().endsWith('.test')) throw notFound('Synthetic account');
    const code = this.auth.devCodes.get(email.toLowerCase());
    if (!code) throw notFound('Sign-in code');
    return { code };
  }
}
