// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { Platform } from 'react-native'
import { safeGetItem, safeSetItem, safeRemoveItem } from './safe-storage'

const STORAGE_KEY = 'shogo_attribution'
const LANDING_KEY = 'shogo_landing_page'
const PENDING_KEY = 'shogo_attribution_pending'

/** How long after signup we will still record attribution once a session exists. */
const EMAIL_ATTRIBUTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const OAUTH_ATTRIBUTION_WINDOW_MS = 10 * 60 * 1000

export interface Attribution {
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  referrer?: string
  landingPage?: string
}

export function captureAttribution(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return
  if (safeGetItem(STORAGE_KEY)) return

  const params = new URLSearchParams(window.location.search)
  const data: Attribution = {
    utmSource: params.get('utm_source') || undefined,
    utmMedium: params.get('utm_medium') || undefined,
    utmCampaign: params.get('utm_campaign') || undefined,
    utmContent: params.get('utm_content') || undefined,
    utmTerm: params.get('utm_term') || undefined,
    referrer: document.referrer || undefined,
    landingPage: window.location.pathname + window.location.search,
  }

  safeSetItem(STORAGE_KEY, JSON.stringify(data))
}

export function getStoredAttribution(): Attribution | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null
  try {
    const raw = safeGetItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as Attribution
  } catch {
    return null
  }
}

export function clearStoredAttribution(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return
  safeRemoveItem(STORAGE_KEY)
  safeRemoveItem(LANDING_KEY)
}

export type SignupMethod = 'email' | 'google' | 'apple'

export interface PendingSignupAttribution extends Attribution {
  method: SignupMethod
}

/**
 * Remember how this visit signed up, plus any UTMs captured on the landing
 * page, until an authenticated session can POST them.
 *
 * Email verification and the Google redirect both leave the browser without
 * a session at the moment of signup. Posting immediately 401s, the error is
 * swallowed, and `signup_attributions` stays empty. The pending payload
 * survives those round trips; `flushSignupAttribution` writes it once the
 * account exists.
 */
export function queueSignupAttribution(method: SignupMethod): void {
  const captured = getStoredAttribution()
  const pending: PendingSignupAttribution = { ...(captured ?? {}), method }
  safeSetItem(PENDING_KEY, JSON.stringify(pending))
}

export function getPendingSignupAttribution(): PendingSignupAttribution | null {
  try {
    const raw = safeGetItem(PENDING_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as PendingSignupAttribution
    if (parsed.method !== 'email' && parsed.method !== 'google' && parsed.method !== 'apple') {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

/** Drop a queued signup without posting. Used when the signed-in account is not new. */
export function discardPendingSignupAttribution(): void {
  safeRemoveItem(PENDING_KEY)
}

/**
 * True when this account is still inside the window where a queued signup
 * should be recorded. Email waits out verification. Google and Apple only
 * cover the redirect, so a later sign-in does not attribute an old account.
 */
export function shouldRecordSignupAttribution(
  pending: PendingSignupAttribution,
  accountCreatedAt: string | Date | null | undefined,
  now = Date.now(),
): boolean {
  if (!accountCreatedAt) return false
  const created = accountCreatedAt instanceof Date ? accountCreatedAt.getTime() : new Date(accountCreatedAt).getTime()
  if (Number.isNaN(created)) return false
  const maxAge = pending.method === 'email' ? EMAIL_ATTRIBUTION_WINDOW_MS : OAUTH_ATTRIBUTION_WINDOW_MS
  return now - created <= maxAge
}

/**
 * POST the queued signup attribution. Clears the queue and the captured UTMs
 * only after the write succeeds, so a 401 during verification can be retried
 * once the session exists. Returns false when nothing is queued.
 */
export async function flushSignupAttribution(
  post: (body: PendingSignupAttribution) => Promise<void>,
): Promise<boolean> {
  const pending = getPendingSignupAttribution()
  if (!pending) return false
  await post(pending)
  discardPendingSignupAttribution()
  clearStoredAttribution()
  return true
}
