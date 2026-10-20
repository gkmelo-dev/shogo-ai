// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The signed-in user's pending workspace invitations, plus accept / decline.
 *
 * An invitation you received is for a workspace you have not joined, so it
 * cannot live inside that workspace's settings. The workspace switcher (phone
 * sheet and wide sidebar) renders this above the workspace list, which is
 * where someone goes to change workspaces.
 *
 * Project invitations are excluded (`projectId` set): those are answered in
 * `ProjectAccessPanel`, and only the workspace-scoped ones change what the
 * switcher can list.
 */

import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '../contexts/auth'
import {
  getDomainHttpClient,
  useDomainActions,
  useDomainHttpOptional,
  useWorkspaceCollection,
} from '../contexts/domain'
import { api } from './api'
import { invitationEvents } from './invitation-events'

export type InviteProcessingState = {
  id: string
  action: 'accept' | 'decline'
} | null

export function usePendingInvitations() {
  const { user } = useAuth()
  // The wide-web popover can render outside `SDKDomainProvider`, so fall back
  // to the provider's singleton client instead of throwing (same as the
  // switcher's activity badge).
  const contextHttp = useDomainHttpOptional()
  const http = contextHttp ?? getDomainHttpClient()
  const actions = useDomainActions()
  const workspaces = useWorkspaceCollection()

  const [pendingInvites, setPendingInvites] = useState<any[]>([])
  const [processingInvite, setProcessingInvite] = useState<InviteProcessingState>(null)
  const [isLoading, setIsLoading] = useState(true)

  const reload = useCallback(async () => {
    if (!http || !user?.email) {
      setPendingInvites([])
      setIsLoading(false)
      return
    }
    try {
      const received = await api.getReceivedInvitations(http, user.email)
      setPendingInvites(received.filter((invite: any) => !invite.projectId))
    } catch (e) {
      console.error('[usePendingInvitations] Failed to load invitations:', e)
    } finally {
      setIsLoading(false)
    }
  }, [http, user?.email])

  /** Resolves true when the invitation was accepted. */
  const acceptInvite = useCallback(
    async (invite: any): Promise<boolean> => {
      setProcessingInvite({ id: invite.id, action: 'accept' })
      let accepted = false
      try {
        await actions.acceptInvitation(invite.id, user?.id || '', {
          workspaceId: invite.workspaceId,
          role: invite.role,
          projectId: invite.projectId ?? undefined,
        })
        accepted = true
        setPendingInvites((prev) => prev.filter((item: any) => item.id !== invite.id))
      } catch (e) {
        console.error('[usePendingInvitations] Failed to accept invitation:', e)
      }
      if (accepted) {
        // The joined workspace has to be in the list before the caller can
        // switch to it, otherwise accepting looks like nothing happened.
        await workspaces
          .loadAll()
          .catch((e: unknown) =>
            console.error('[usePendingInvitations] Failed to reload workspaces:', e),
          )
        invitationEvents.emit()
      }
      setProcessingInvite(null)
      return accepted
    },
    [actions, user?.id, workspaces],
  )

  /** Resolves true when the invitation was declined. */
  const declineInvite = useCallback(
    async (invite: any): Promise<boolean> => {
      setProcessingInvite({ id: invite.id, action: 'decline' })
      let declined = false
      try {
        await actions.declineInvitation(invite.id)
        declined = true
        setPendingInvites((prev) => prev.filter((item: any) => item.id !== invite.id))
      } catch (e) {
        console.error('[usePendingInvitations] Failed to decline invitation:', e)
      }
      if (declined) invitationEvents.emit()
      setProcessingInvite(null)
      return declined
    },
    [actions],
  )

  // Mount is "the sheet/sidebar opened": the phone sheet and the popover both
  // unmount their content while closed. No timer — an invite sent while the
  // app sits open shows on the next open or focus.
  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => invitationEvents.subscribe(() => void reload()), [reload])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: string) => {
      if (state === 'active') void reload()
    })
    return () => subscription.remove()
  }, [reload])

  return { pendingInvites, processingInvite, isLoading, reload, acceptInvite, declineInvite }
}
