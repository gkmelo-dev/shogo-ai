// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Free trial on paid plan upgrades.
 *
 * - Card is required up front (Stripe Checkout `payment_method_collection:
 *   'always'`), $0 due today, auto-charges when the trial ends.
 * - `missing_payment_method: 'cancel'` so a trial that ends without a payment
 *   method cancels instead of silently running free.
 * - One trial per user and per workspace. A card may start only one trial:
 *   its fingerprint is recorded in `trial_redemptions` and a second trial on
 *   the same card is cancelled right after it starts.
 * - While trialing, the workspace is entitled to its plan's rolling windows
 *   (`getEffectivePlanId` treats `trialing` as entitled), but the monthly
 *   allowance and overage wait for the first paid invoice.
 */

import type Stripe from 'stripe'
import { prisma } from '../lib/prisma'
import { TRIAL_ELIGIBLE_PLANS } from '../config/usage-plans'

export interface TrialEligibility {
  eligible: boolean
  reason?: 'plan_not_eligible' | 'already_used' | 'existing_subscription' | 'risk_review'
}

/**
 * Whether a checkout for `workspaceId` may start a trial. `planId` is optional:
 * the workspace-plan endpoint uses the plan-agnostic check to decide whether to
 * show the trial CTA at all.
 */
export async function trialEligibility(params: {
  userId: string | null | undefined
  workspaceId: string
  planId?: string
}): Promise<TrialEligibility> {
  if (params.planId && !(TRIAL_ELIGIBLE_PLANS as readonly string[]).includes(params.planId)) {
    return { eligible: false, reason: 'plan_not_eligible' }
  }

  const priorRedemption = await prisma.trialRedemption.findFirst({
    where: {
      OR: [
        { workspaceId: params.workspaceId },
        ...(params.userId ? [{ userId: params.userId }] : []),
      ],
    },
    select: { id: true },
  })
  if (priorRedemption) return { eligible: false, reason: 'already_used' }

  // A workspace that already had a subscription (any status) has used its
  // paid entry. Trials are for first-time upgrades only.
  const priorSubscription = await prisma.subscription.findFirst({
    where: { workspaceId: params.workspaceId },
    select: { id: true },
  })
  if (priorSubscription) return { eligible: false, reason: 'existing_subscription' }

  if (params.userId) {
    const assessment = await prisma.signupRiskAssessment.findUnique({
      where: { userId: params.userId },
      select: { band: true },
    })
    if (assessment?.band === 'high') return { eligible: false, reason: 'risk_review' }
  }

  return { eligible: true }
}

/**
 * Stripe Checkout parameters for a trial. Returns `{}` when `trialDays` is 0 so
 * callers can spread it unconditionally.
 *
 * `subscriptionMetadata` must carry `workspaceId`/`planId`/`billingInterval`:
 * the webhook handlers identify the workspace from the subscription's metadata
 * (see the invoice refill path), so a trial subscription has to be identifiable
 * the same way a paid one is.
 */
export function trialCheckoutParams(
  trialDays: number,
  subscriptionMetadata: Record<string, string>,
): {
  payment_method_collection?: 'always'
  subscription_data?: Partial<Stripe.Checkout.SessionCreateParams.SubscriptionData>
  metadata?: Record<string, string>
} {
  if (trialDays <= 0) return {}
  return {
    payment_method_collection: 'always',
    subscription_data: {
      trial_period_days: trialDays,
      trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
      metadata: { ...subscriptionMetadata, trial: 'true' },
    },
    metadata: { trial: 'true', trialDays: String(trialDays) },
  }
}

/**
 * Called from the subscription webhook for a `trialing` subscription. Records
 * the trial and enforces one-trial-per-card. Returns `'blocked'` when the card
 * was already used for a trial on another workspace; the subscription is then
 * cancelled and the caller must not allocate the wallet.
 */
export async function recordTrialStart(params: {
  stripe: Stripe
  workspaceId: string
  userId: string | null
  planId: string
  subscriptionId: string
  stripeCustomerId: string
}): Promise<'recorded' | 'already_recorded' | 'blocked'> {
  const existing = await prisma.trialRedemption.findUnique({
    where: { workspaceId: params.workspaceId },
    select: { stripeSubscriptionId: true, status: true },
  })
  if (existing?.stripeSubscriptionId === params.subscriptionId) {
    // A re-delivered webhook must not un-block a duplicate-card trial.
    return existing.status === 'blocked_duplicate_card' ? 'blocked' : 'already_recorded'
  }
  const userId = params.userId ?? (await workspaceOwnerUserId(params.workspaceId))
  if (!userId) throw new Error(`[trial] no owner user for workspace ${params.workspaceId}`)

  const sub = await params.stripe.subscriptions.retrieve(params.subscriptionId, {
    expand: ['default_payment_method'],
  })
  const pm = sub.default_payment_method
  const fingerprint =
    pm && typeof pm === 'object' && pm.type === 'card' ? (pm.card?.fingerprint ?? null) : null

  if (fingerprint) {
    const sameCard = await prisma.trialRedemption.findUnique({
      where: { cardFingerprint: fingerprint },
      select: { workspaceId: true },
    })
    if (sameCard && sameCard.workspaceId !== params.workspaceId) {
      await params.stripe.subscriptions.cancel(params.subscriptionId)
      await prisma.trialRedemption.upsert({
        where: { workspaceId: params.workspaceId },
        create: {
          userId,
          workspaceId: params.workspaceId,
          stripeCustomerId: params.stripeCustomerId,
          stripeSubscriptionId: params.subscriptionId,
          cardFingerprint: null,
          planId: params.planId,
          status: 'blocked_duplicate_card',
        },
        update: { status: 'blocked_duplicate_card', stripeSubscriptionId: params.subscriptionId },
      })
      console.warn('[trial] blocked duplicate card trial', {
        workspaceId: params.workspaceId,
        matchedWorkspaceId: sameCard.workspaceId,
      })
      return 'blocked'
    }
  }

  await prisma.trialRedemption.upsert({
    where: { workspaceId: params.workspaceId },
    create: {
      userId,
      workspaceId: params.workspaceId,
      stripeCustomerId: params.stripeCustomerId,
      stripeSubscriptionId: params.subscriptionId,
      cardFingerprint: fingerprint,
      planId: params.planId,
      status: 'trialing',
    },
    update: {
      stripeSubscriptionId: params.subscriptionId,
      cardFingerprint: fingerprint,
      planId: params.planId,
      status: 'trialing',
    },
  })
  return 'recorded'
}

async function workspaceOwnerUserId(workspaceId: string): Promise<string | null> {
  const owner = await prisma.member.findFirst({
    where: { workspaceId, role: 'owner', projectId: null },
    select: { userId: true },
    orderBy: { createdAt: 'asc' },
  })
  return owner?.userId ?? null
}

/** Mark a recorded trial as converted (first paid invoice) or ended. */
export async function markTrialStatus(workspaceId: string, status: 'converted' | 'ended'): Promise<void> {
  await prisma.trialRedemption.updateMany({ where: { workspaceId }, data: { status } })
}
