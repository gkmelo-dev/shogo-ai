// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-4 + SHO-19 in local mode: a cold start opens the workspace agent at `/`
 * with a **fresh** empty chat for a team workspace, and repeated cold starts
 * reuse that one empty chat instead of minting a row each time. The old team
 * home is at `/home`, an explicit `?chatSessionId=` still wins, and a personal
 * workspace keeps resuming its primary chat.
 *
 * Local counterpart to `e2e/staging/land-on-agent.test.ts` — it needs the local
 * stack (auto-sign-in), not a hosted target. `E2E_LOCAL_START_STACK=1` boots it.
 *
 *   npx playwright test --config e2e/local/playwright.config.ts land-on-agent
 */
import { expect, test, type Page } from "@playwright/test"
import { LOCAL_API_BASE } from "./helpers"
import { activateTeamWorkspace, signIn, teamWorkspaceId } from "./team-nav-seed"

/** The workspace agent's composer (ChatInput's default accessibility label). */
function composer(page: Page) {
  return page
    .getByRole("textbox", { name: "Chat message input" })
    .filter({ visible: true })
    .first()
}

interface SessionRow {
  id: string
  inferredName?: string | null
  messageCount?: number
}

async function sessions(page: Page, workspaceId: string): Promise<SessionRow[]> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/sessions`)
  expect(res.ok(), `list sessions failed: ${res.status()}`).toBe(true)
  const json = await res.json()
  return (json?.sessions ?? json?.items ?? []) as SessionRow[]
}

async function sessionIds(page: Page, workspaceId: string): Promise<string[]> {
  return (await sessions(page, workspaceId)).map((row) => row.id)
}

/**
 * Give a chat a message without running a model turn: the landing only reads
 * the message count, and this writes the same row the chat path writes.
 */
async function sendFirstMessage(page: Page, sessionId: string): Promise<void> {
  const res = await page.request.post(`${LOCAL_API_BASE}/api/chat-messages`, {
    data: { sessionId, role: "user", content: "hello from the land-on-agent e2e" },
  })
  expect(res.ok(), `could not create a chat message: ${res.status()} ${await res.text()}`).toBe(true)
}

async function personalWorkspaceId(page: Page): Promise<string> {
  const res = await page.request.get(`${LOCAL_API_BASE}/api/workspaces`)
  const json = await res.json()
  const items = (json?.items ?? json?.data?.items ?? []) as Array<{ id: string; kind?: string }>
  const id = items.find((w) => w.kind === "personal")?.id
  if (!id) throw new Error(`local stack has no personal workspace: ${JSON.stringify(json)}`)
  return id
}

test.describe("Landing on the workspace agent (local)", () => {
  test("ten cold starts reuse one empty chat; a used chat is left behind for a new one", async ({ page }) => {
    test.setTimeout(300_000)
    await signIn(page)
    const workspaceId = await teamWorkspaceId(page)
    await activateTeamWorkspace(page, workspaceId)

    const before = await sessionIds(page, workspaceId)

    // Ten cold starts (a reload is what a reopen does) must leave one chat.
    for (let load = 0; load < 10; load += 1) {
      await page.goto("/")
      await expect(composer(page)).toBeVisible({ timeout: 90_000 })
      expect(new URL(page.url()).pathname).toBe("/")
      await expect(page.getByText("What are we building", { exact: false })).toHaveCount(0)
    }

    const afterTen = await sessionIds(page, workspaceId)
    const minted = afterTen.filter((id) => !before.includes(id))
    expect(minted, "ten cold starts must leave exactly one empty landing chat").toHaveLength(1)
    const landing = minted[0]

    const landingRow = (await sessions(page, workspaceId)).find((row) => row.id === landing)
    expect(landingRow?.messageCount, "the reused chat should still be empty").toBe(0)

    // The first message stays in that chat: nothing new is minted around it.
    await sendFirstMessage(page, landing)
    expect((await sessionIds(page, workspaceId)).sort()).toEqual([...afterTen].sort())

    // A cold start on a chat that now has a conversation opens a fresh one.
    await page.goto("/")
    await expect(composer(page)).toBeVisible({ timeout: 90_000 })
    const afterNext = await sessionIds(page, workspaceId)
    const mintedNext = afterNext.filter((id) => !afterTen.includes(id))
    expect(mintedNext, "the landing reopened the previous conversation").toHaveLength(1)
    expect(mintedNext[0]).not.toBe(landing)

    // An explicit session in the URL still wins and mints nothing.
    await page.goto(`/agent?chatSessionId=${landing}`)
    await expect(composer(page)).toBeVisible({ timeout: 90_000 })
    expect(new URL(page.url()).searchParams.get("chatSessionId")).toBe(landing)
    expect((await sessionIds(page, workspaceId)).sort()).toEqual([...afterNext].sort())

    // The pre-landing team home is one route away, and the TeamDock points there.
    await page.goto("/home")
    await expect(page.getByText("What are we building", { exact: false }).first()).toBeVisible({
      timeout: 60_000,
    })
    expect(new URL(page.url()).pathname).toBe("/home")
  })

  test("a personal cold start keeps resuming its last chat", async ({ page }) => {
    test.setTimeout(180_000)
    await signIn(page)
    const workspaceId = await personalWorkspaceId(page)
    await page.addInitScript((id) => {
      localStorage.setItem("shogo:active-workspace-id", id)
      localStorage.setItem("shogo:active-workspace-kind", JSON.stringify({ id, kind: "personal" }))
    }, workspaceId)

    // The first load may create the workspace's primary session; after that the
    // count must not grow — personal never mints a landing chat.
    await page.goto("/")
    await expect(composer(page)).toBeVisible({ timeout: 90_000 })
    const settled = await sessionIds(page, workspaceId)

    await page.reload()
    await expect(composer(page)).toBeVisible({ timeout: 90_000 })
    expect((await sessionIds(page, workspaceId)).sort()).toEqual([...settled].sort())
    expect(new URL(page.url()).pathname).toBe("/")
  })
})
