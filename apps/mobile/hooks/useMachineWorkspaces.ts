// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * useMachineWorkspaces — a paired desktop's own workspaces for the switcher
 * (SHO-54).
 *
 * Reads `/api/machines` (owner-scoped, across cloud workspaces) and then each
 * machine's `/api/machines/:id/workspaces`, which relays the desktop's
 * `/api/local/machine`. The list response already carries the last heartbeat
 * snapshot, so an offline machine still renders its last-known workspaces
 * instead of the group vanishing.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { API_URL } from "../lib/api"
import type { MachineGroupData, MachinePresence } from "../components/layout/sidebar/MachineWorkspacesGroup"

interface MachineListItem {
  id: string
  name: string
  hostname?: string
  kind?: string
  status?: MachinePresence
  lastSeenAt?: string | null
  snapshot?: {
    workspaces?: MachineGroupData["workspaces"]
  } | null
}

function toPresence(status: string | undefined): MachinePresence {
  return status === "online" || status === "heartbeat" || status === "offline" ? status : "offline"
}

export interface UseMachineWorkspacesResult {
  machines: MachineGroupData[]
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useMachineWorkspaces(): UseMachineWorkspacesResult {
  const [machines, setMachines] = useState<MachineGroupData[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  useEffect(() => {
    if (!API_URL) return
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`${API_URL}/api/machines`, { credentials: "include" })
        const body = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (!cancelled) {
            setMachines([])
            setError((body as any)?.error?.message ?? `Could not load your machines (HTTP ${res.status})`)
          }
          return
        }
        const list = ((body as any)?.machines ?? []) as MachineListItem[]
        if (cancelled) return

        // Render the cached snapshot immediately — an offline machine keeps its
        // rows (greyed) instead of disappearing from the switcher.
        const seeded: MachineGroupData[] = list.map((machine) => ({
          id: machine.id,
          name: machine.name,
          status: toPresence(machine.status),
          lastSeenAt: machine.lastSeenAt ?? null,
          stale: toPresence(machine.status) !== "online",
          workspaces: machine.snapshot?.workspaces ?? [],
        }))
        setMachines(seeded)

        const live = await Promise.all(
          seeded.map(async (machine) => {
            try {
              const wsRes = await fetch(`${API_URL}/api/machines/${machine.id}/workspaces`, {
                credentials: "include",
              })
              if (!wsRes.ok) return machine
              const wsBody = (await wsRes.json()) as any
              return {
                ...machine,
                status: toPresence(wsBody?.status ?? machine.status),
                stale: !!wsBody?.stale,
                workspaces: (wsBody?.workspaces ?? machine.workspaces) as MachineGroupData["workspaces"],
              }
            } catch {
              return machine
            }
          }),
        )
        if (!cancelled) setMachines(live)
      } catch (err: any) {
        if (!cancelled) {
          setMachines([])
          setError(err?.message ?? "Could not reach Shogo Cloud")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [nonce])

  return useMemo(() => ({ machines, loading, error, refresh }), [machines, loading, error, refresh])
}
