// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Social management domain services. Every provider call inside these modules
 * goes through `./client`, which is the single insert point for Zernio.
 */

export * from './client'
export * from './profiles.service'
export * from './accounts.service'
export * from './publishing.service'
