// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Signup promo credit: grants, verification release, admin overrides, expiry.
 *
 * Credit lives on the signup's team workspace wallet (`usage_wallets`), which
 * is where the user builds. It is spent by `_consumeUsageTransaction` after the
 * rolling windows and before overage.
 *
 * Idempotency: `usage_wallets.promoCreditStage` only moves forward
 * (0 none -> 1 initial granted -> 2 fully granted). Every grant is a conditional
 * `updateMany` on the stage, so retries, duplicate verification links and
 * concurrent hooks can't pay out twice.
 */

import { prisma } from '../lib/prisma'
import {
  SIGNUP_CREDIT_TOTAL_USD,
  SIGNUP_CREDIT_TTL_DAYS,
  SIGNUP_CREDIT_VERIFIED_USD,
} from '../config/usage-plans'
import { allocateFreeWallet } from './billing.service'
import { homeWorkspaceIds } from '../lib/region'
import {
  collectSignupRiskFeatures,
  recordSignupRiskAssessment,
  type SignupRequestInfo,
} from './signup-risk.service'
import {
  scoreSignupRisk,
  type SignupProvider,
  type SignupRiskResult,
} from './signup-risk-scoring'

/** Credit decisions stored on `signup_risk_assessments.decision`. */
export const CREDIT_DECISIONS = {
  full: 'credit_full',
  initial: 'credit_initial',
  held: 'credit_held',
  none: 'no_credit',
  released: 'credit_released',
} as const

const STAGE_INITIAL = 1
const STAGE_FULL = 2

/** Team workspace for the user (the one they build in). Null if none exists. */
export async function findSignupCreditWorkspaceId(userId: string): Promise<string | null> {
  const member = await prisma.member.findFirst({
    where: {
      userId,
      role: 'owner',
      projectId: null,
      workspace: { kind: 'team', parentWorkspaceId: null },
    },
    select: { workspaceId: true },
    orderBy: { createdAt: 'asc' },
  })
  return member?.workspaceId ?? null
}

/**
 * Add promo credit and advance the stage. The expiry is anchored to the first
 * grant (stage 0 -> n) and is not extended by later stages.
 * Returns true if this call changed the wallet.
 */
export async function grantPromoCredit(params: {
  workspaceId: string
  amountUsd: number
  toStage: typeof STAGE_INITIAL | typeof STAGE_FULL
  now?: Date
}): Promise<boolean> {
  const { workspaceId, amountUsd, toStage } = params
  const now = params.now ?? new Date()
  await allocateFreeWallet(workspaceId)

  const inc = {
    promoCreditUsd: { increment: amountUsd },
    promoCreditGrantedUsd: { increment: amountUsd },
    promoCreditStage: toStage,
  }
  const first = await prisma.usageWallet.updateMany({
    where: { workspaceId, promoCreditStage: 0 },
    data: {
      ...inc,
      promoCreditExpiresAt: new Date(now.getTime() + SIGNUP_CREDIT_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
  })
  if (first.count > 0) return true

  const next = await prisma.usageWallet.updateMany({
    where: { workspaceId, promoCreditStage: { gt: 0, lt: toStage } },
    data: inc,
  })
  return next.count > 0
}

/**
 * Apply the new-signup decision: initial grant and decision record. Called from
 * the `user.create.after` hook once the team workspace exists.
 */
export async function applyInitialSignupCredit(params: {
  userId: string
  result: SignupRiskResult
  now?: Date
}): Promise<{ granted: boolean; workspaceId: string | null }> {
  const { result } = params
  const workspaceId = await findSignupCreditWorkspaceId(params.userId)
  if (!workspaceId || result.decision === CREDIT_DECISIONS.none) {
    return { granted: false, workspaceId }
  }

  // Verified at signup gets the full amount now. Otherwise stage 1 (low gets
  // the initial part, medium gets nothing until verification).
  const toStage = result.decision === CREDIT_DECISIONS.full ? STAGE_FULL : STAGE_INITIAL
  const granted = await grantPromoCredit({
    workspaceId,
    amountUsd: result.initialCreditUsd,
    toStage,
    now: params.now,
  })
  return { granted, workspaceId }
}

export interface VerificationReleaseOutcome {
  released: boolean
  reason:
    | 'no_assessment'
    | 'not_eligible'
    | 'rescored_high_risk'
    | 'no_workspace'
    | 'released'
  band?: string
  amountUsd?: number
}

/**
 * Re-score a signup once its email is verified, then release the rest of the
 * credit if it still qualifies. The re-score uses the stored features (IP, device,
 * canonical email) and counts accounts created since signup, so a burst that
 * arrives after the first signup is caught here.
 */
export async function releaseSignupCreditOnVerification(params: {
  userId: string
  now?: Date
}): Promise<VerificationReleaseOutcome> {
  const now = params.now ?? new Date()
  const assessment = await prisma.signupRiskAssessment.findUnique({
    where: { userId: params.userId },
  })
  if (!assessment) return { released: false, reason: 'no_assessment' }
  if (assessment.decision !== CREDIT_DECISIONS.initial && assessment.decision !== CREDIT_DECISIONS.held) {
    return { released: false, reason: 'not_eligible' }
  }

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { email: true },
  })
  if (!user) return { released: false, reason: 'no_assessment' }

  const signals = (assessment.signals ?? {}) as {
    provider?: SignupProvider
    allowlisted?: boolean
    country?: string | null
  }
  const request: SignupRequestInfo = {
    ip: assessment.ip,
    ipPrefix: assessment.ipPrefix,
    country: assessment.country,
    deviceId: assessment.deviceId,
    e2eAllowlisted: signals.allowlisted === true,
  }
  const features = await collectSignupRiskFeatures({
    userId: params.userId,
    email: user.email,
    provider: signals.provider ?? 'credential',
    emailVerified: true,
    request,
    now,
  })
  const result = scoreSignupRisk(features)

  if (result.band === 'high' || (result.disposableDomain && !result.allowlisted)) {
    await recordSignupRiskAssessment({
      userId: params.userId,
      email: user.email,
      provider: signals.provider ?? 'credential',
      request,
      result,
      decision: CREDIT_DECISIONS.none,
    })
    return { released: false, reason: 'rescored_high_risk', band: result.band }
  }

  const workspaceId = await findSignupCreditWorkspaceId(params.userId)
  if (!workspaceId) return { released: false, reason: 'no_workspace' }

  // Initial stage already granted $2 (low band) → release the rest. Held (medium)
  // had nothing yet → release the full amount.
  const amountUsd =
    assessment.decision === CREDIT_DECISIONS.initial ? SIGNUP_CREDIT_VERIFIED_USD : SIGNUP_CREDIT_TOTAL_USD
  await grantPromoCredit({ workspaceId, amountUsd, toStage: STAGE_FULL, now })
  await recordSignupRiskAssessment({
    userId: params.userId,
    email: user.email,
    provider: signals.provider ?? 'credential',
    request,
    result,
    decision: CREDIT_DECISIONS.released,
  })
  return { released: true, reason: 'released', band: result.band, amountUsd }
}

/** Admin: grant the full credit regardless of band. Idempotent via the stage. */
export async function approveSignupCredit(params: {
  userId: string
  adminUserId: string
  now?: Date
}): Promise<{ granted: boolean }> {
  const workspaceId = await findSignupCreditWorkspaceId(params.userId)
  if (!workspaceId) return { granted: false }
  // Top up only what is still owed: $2 may already be granted at signup.
  const wallet = await prisma.usageWallet.findUnique({
    where: { workspaceId },
    select: { promoCreditGrantedUsd: true },
  })
  const remaining = Math.max(0, SIGNUP_CREDIT_TOTAL_USD - (wallet?.promoCreditGrantedUsd ?? 0))
  const granted = remaining > 0
    ? await grantPromoCredit({ workspaceId, amountUsd: remaining, toStage: STAGE_FULL, now: params.now })
    : false
  await prisma.signupRiskAssessment.updateMany({
    where: { userId: params.userId },
    data: {
      reviewDecision: 'approved',
      reviewedByUserId: params.adminUserId,
      reviewedAt: new Date(),
    },
  })
  return { granted }
}

/**
 * Admin: zero the remaining promo balance and stop any future release. The
 * granted total is kept for the audit trail.
 */
export async function revokeSignupCredit(params: {
  userId: string
  adminUserId: string
  reviewDecision?: 'revoked' | 'banned'
}): Promise<{ revokedUsd: number }> {
  const workspaceId = await findSignupCreditWorkspaceId(params.userId)
  let revokedUsd = 0
  if (workspaceId) {
    const wallet = await prisma.usageWallet.findUnique({
      where: { workspaceId },
      select: { promoCreditUsd: true },
    })
    revokedUsd = wallet?.promoCreditUsd ?? 0
    await prisma.usageWallet.updateMany({
      where: { workspaceId },
      data: { promoCreditUsd: 0 },
    })
  }
  await prisma.signupRiskAssessment.updateMany({
    where: { userId: params.userId },
    data: {
      decision: CREDIT_DECISIONS.none,
      reviewDecision: params.reviewDecision ?? 'revoked',
      reviewedByUserId: params.adminUserId,
      reviewedAt: new Date(),
    },
  })
  return { revokedUsd }
}

/**
 * Zero promo balances whose expiry has passed and record one zero-cost
 * `UsageEvent` per workspace for the audit trail. `billedUsd` is 0, so usage
 * totals are unchanged. Returns the number of wallets expired.
 */
export async function expireSignupCredits(now: Date = new Date(), batchSize = 500): Promise<number> {
  const candidates = await prisma.usageWallet.findMany({
    where: { promoCreditUsd: { gt: 0 }, promoCreditExpiresAt: { lte: now } },
    select: { workspaceId: true, promoCreditUsd: true },
    take: batchSize,
  })
  // usage_wallets is home-region partitioned (never replicated), so each region
  // only expires the wallets it owns. `null` = single-region / local: all of them.
  const home = await homeWorkspaceIds(candidates.map((w) => w.workspaceId))
  const due = home ? candidates.filter((w) => home.has(w.workspaceId)) : candidates
  let expired = 0
  for (const wallet of due) {
    const res = await prisma.usageWallet.updateMany({
      where: {
        workspaceId: wallet.workspaceId,
        promoCreditUsd: { gt: 0 },
        promoCreditExpiresAt: { lte: now },
      },
      data: { promoCreditUsd: 0 },
    })
    if (res.count === 0) continue
    expired += 1

    const owner = await prisma.member.findFirst({
      where: { workspaceId: wallet.workspaceId, projectId: null },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!owner) {
      console.warn('[signup-credit] expired credit with no member to attribute the event to', {
        workspaceId: wallet.workspaceId,
      })
      continue
    }
    await prisma.usageEvent.create({
      data: {
        workspaceId: wallet.workspaceId,
        memberId: owner.id,
        actionType: 'signup_credit_expired',
        actionMetadata: { expiredUsd: wallet.promoCreditUsd },
        rawUsd: null,
        billedUsd: 0,
        source: 'promo',
        balanceBefore: wallet.promoCreditUsd,
        balanceAfter: 0,
      },
    })
  }
  return expired
}
