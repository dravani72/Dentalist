import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  AdjustmentRequest,
  ChargeCodeRequest,
  ClaimCreateRequest,
  ClaimVoidRequest,
  FeeRequest,
  FeeScheduleRequest,
  InsurancePolicyRequest,
  PatientPaymentRequest,
  PayerRequest,
  RefundRequest,
  ReversalRequest,
} from '@teeth/shared';
import { z } from 'zod';
import { body } from '../common/http';
import { CurrentActor } from '../auth/auth.guard';
import type { Actor } from '../auth/actor';
import { BillingService } from './billing.service';
import { ClaimsService } from './claims.service';

const PostChargesRequest = z.object({ procedureIds: z.array(z.string().uuid()).min(1).max(100).optional() });
const DateQuery = z.object({ on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const StatusQuery = z.object({ status: z.string().max(20).optional() });
const CodeQuery = z.object({ q: z.string().trim().min(1).max(60) });

@Controller()
export class BillingController {
  constructor(
    @Inject(BillingService) private readonly billing: BillingService,
    @Inject(ClaimsService) private readonly claims: ClaimsService,
  ) {}

  // patient account
  @Get('patients/:id/billing')
  account(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.account(actor, id);
  }

  @Get('patients/:id/estimate')
  estimate(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.estimate(actor, id);
  }

  @Post('patients/:id/charges')
  postCharges(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PostChargesRequest)) req: z.infer<typeof PostChargesRequest>) {
    return this.billing.postCharges(actor, id, req.procedureIds);
  }

  @Post('procedures/:id/billing-code')
  setCode(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ChargeCodeRequest)) req: z.infer<typeof ChargeCodeRequest>) {
    return this.billing.setCode(actor, id, req);
  }

  @Get('billing-codes')
  codes(@CurrentActor() actor: Actor, @Query() q: unknown) {
    return this.billing.codeSearch(actor, body(CodeQuery).transform(q).q);
  }

  @Post('payments')
  pay(@CurrentActor() actor: Actor, @Body(body(PatientPaymentRequest)) req: z.infer<typeof PatientPaymentRequest>) {
    return this.billing.postPayment(actor, req);
  }

  @Post('adjustments')
  adjust(@CurrentActor() actor: Actor, @Body(body(AdjustmentRequest)) req: z.infer<typeof AdjustmentRequest>) {
    return this.billing.adjust(actor, req);
  }

  @Post('refunds')
  refund(@CurrentActor() actor: Actor, @Body(body(RefundRequest)) req: z.infer<typeof RefundRequest>) {
    return this.billing.refund(actor, req);
  }

  @Post('ledger-entries/:id/reverse')
  reverse(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ReversalRequest)) req: z.infer<typeof ReversalRequest>) {
    return this.billing.reverse(actor, id, req.note);
  }

  // insurance
  @Get('payers')
  payers(@CurrentActor() actor: Actor) {
    return this.billing.payers(actor);
  }

  @Post('payers')
  createPayer(@CurrentActor() actor: Actor, @Body(body(PayerRequest)) req: z.infer<typeof PayerRequest>) {
    return this.billing.savePayer(actor, req);
  }

  @Post('payers/:id')
  updatePayer(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(PayerRequest)) req: z.infer<typeof PayerRequest>) {
    return this.billing.savePayer(actor, req, id);
  }

  @Post('patients/:id/insurance')
  addPolicy(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(InsurancePolicyRequest)) req: z.infer<typeof InsurancePolicyRequest>) {
    return this.billing.savePolicy(actor, id, req);
  }

  @Post('patients/:id/insurance/:policyId')
  updatePolicy(
    @CurrentActor() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('policyId', ParseUUIDPipe) policyId: string,
    @Body(body(InsurancePolicyRequest)) req: z.infer<typeof InsurancePolicyRequest>,
  ) {
    return this.billing.savePolicy(actor, id, req, policyId);
  }

  @Post('insurance-policies/:id/remove')
  removePolicy(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.removePolicy(actor, id);
  }

  @Post('insurance-policies/:id/eligibility')
  eligibility(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.billing.checkEligibility(actor, id);
  }

  // fee schedules
  @Get('fee-schedules')
  schedules(@CurrentActor() actor: Actor) {
    return this.billing.feeSchedules(actor);
  }

  @Post('fee-schedules')
  createSchedule(@CurrentActor() actor: Actor, @Body(body(FeeScheduleRequest)) req: z.infer<typeof FeeScheduleRequest>) {
    return this.billing.createSchedule(actor, req);
  }

  @Get('fee-schedules/:id')
  fees(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.billing.fees(actor, id, body(DateQuery).transform(q).on);
  }

  @Post('fee-schedules/:id/fees')
  setFee(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(FeeRequest)) req: z.infer<typeof FeeRequest>) {
    return this.billing.setFee(actor, id, req);
  }

  // claims and remittance
  @Get('billing/unbilled')
  unbilled(@CurrentActor() actor: Actor) {
    return this.billing.unbilledQueue(actor);
  }

  @Get('claims')
  claimQueue(@CurrentActor() actor: Actor, @Query() q: unknown) {
    return this.claims.queue(actor, body(StatusQuery).transform(q).status);
  }

  @Post('claims')
  createClaim(@CurrentActor() actor: Actor, @Body(body(ClaimCreateRequest)) req: z.infer<typeof ClaimCreateRequest>) {
    return this.claims.create(actor, req);
  }

  @Post('claims/:id/submit')
  submit(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.claims.submit(actor, id);
  }

  @Post('claims/:id/void')
  voidClaim(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body(body(ClaimVoidRequest)) req: z.infer<typeof ClaimVoidRequest>) {
    return this.claims.void(actor, id, req.reason);
  }

  @Post('remittances/fetch')
  fetch(@CurrentActor() actor: Actor) {
    return this.claims.checkForPayments(actor);
  }

  @Get('remittances')
  remittances(@CurrentActor() actor: Actor) {
    return this.claims.remittances(actor);
  }
}
