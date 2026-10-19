// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The one place a workspace join sends mail (SHO-51).
 *
 * Invitations and invite links both create a `Member`, and both notify from two
 * independent layers used to reach the same person twice — "X joined" from the
 * member hook and "X accepted your invitation" from the invitation hook / accept
 * route. Recipients are resolved once here, keyed by address, so an inviter-owner
 * gets exactly one mail: the "accepted" one, because they already know they
 * invited. Everyone else who owns the workspace gets "joined".
 *
 * Called from `onWorkspaceMemberJoined` and only for a new `member.joined`
 * event, so a replayed accept sends nothing.
 */

import { prisma } from '../lib/prisma'
import { sendInviteAcceptedEmail, sendMemberJoinedEmail } from './email.service'

const db = prisma as any

export interface NotifyWorkspaceJoinedInput {
  workspaceId: string
  userId: string
  memberId: string
  role?: string | null
  /** Who invited/created the link, when the caller knows. Otherwise resolved from the accepted invitation. */
  invitedBy?: string | null
}

type JoinMail = 'invite-accepted' | 'member-joined'

function frontendUrl(): string {
  return process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3001'
}

/** The accepted workspace invitation behind this membership, if there is one. */
async function resolveInviterId(workspaceId: string, email: string | null | undefined): Promise<string | null> {
  if (!email) return null
  const invitation = await db.invitation.findFirst({
    where: {
      workspaceId,
      status: 'accepted',
      invitedBy: { not: null },
      email: { in: [email, email.toLowerCase()] },
    },
    orderBy: { updatedAt: 'desc' },
    select: { invitedBy: true },
  })
  return invitation?.invitedBy ?? null
}

export async function notifyWorkspaceJoined(input: NotifyWorkspaceJoinedInput): Promise<void> {
  try {
    const [user, workspace, owners] = await Promise.all([
      db.user.findUnique({ where: { id: input.userId }, select: { name: true, email: true } }),
      db.workspace.findUnique({ where: { id: input.workspaceId }, select: { name: true } }),
      db.member.findMany({
        where: { workspaceId: input.workspaceId, role: 'owner', projectId: null, userId: { not: input.userId } },
        include: { user: { select: { email: true } } },
      }),
    ])
    if (!workspace) return

    const joinedEmail = (user?.email ?? '').toLowerCase() || null
    const inviterId = input.invitedBy ?? (await resolveInviterId(input.workspaceId, user?.email))

    // One entry per address: the inviter's mail wins over the generic one.
    const recipients = new Map<string, JoinMail>()
    const add = (email: string | null | undefined, mail: JoinMail) => {
      const key = (email ?? '').toLowerCase()
      if (!key || key === joinedEmail) return
      if (recipients.has(key)) return
      recipients.set(key, mail)
    }
    for (const owner of owners) {
      add(owner.user?.email, owner.userId === inviterId ? 'invite-accepted' : 'member-joined')
    }
    if (inviterId && inviterId !== input.userId) {
      const inviter = await db.user.findUnique({ where: { id: inviterId }, select: { email: true } })
      add(inviter?.email, 'invite-accepted')
    }
    if (recipients.size === 0) return

    const memberName = user?.name || user?.email || 'A new member'
    const memberEmail = user?.email || ''
    const dashboardUrl = `${frontendUrl()}/settings?tab=people`

    await Promise.allSettled(
      [...recipients].map(([email, mail]) =>
        mail === 'invite-accepted'
          ? sendInviteAcceptedEmail({
              to: email,
              inviteeName: memberName,
              inviteeEmail: memberEmail,
              resourceName: workspace.name,
              resourceType: 'workspace',
              dashboardUrl,
            })
          : sendMemberJoinedEmail({
              to: email,
              memberName,
              memberEmail,
              workspaceName: workspace.name,
              role: input.role || 'member',
              dashboardUrl,
            }),
      ),
    )
  } catch (error) {
    console.error('[JoinNotifications] send failed:', error instanceof Error ? error.message : error)
  }
}
