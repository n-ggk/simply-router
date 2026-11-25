import type { Plugin } from "@opencode/plugin/promise/plugin"

export const KEYS = [
  "thk_live_conta1_key",
  "thk_live_conta2_key",
  "thk_live_conta3_key",
]

export const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

const TOKEN_HARBOR_HOST = "tokenharbor.ai"
const cooldowns = new Map<string, number>()
let currentIndex = 0

export function getNextAvailableKey(): { key: string; index: number } | null {
  const now = Date.now()

  for (let offset = 0; offset < KEYS.length; offset++) {
    const index = (currentIndex + offset) % KEYS.length
    const key = KEYS[index]
    const cooldownUntil = cooldowns.get(key)

    if (cooldownUntil === undefined || now >= cooldownUntil) {
      if (cooldownUntil !== undefined) cooldowns.delete(key)
      currentIndex = (index + 1) % KEYS.length
      return { key, index }
    }
  }

  return null
}

export function markKeyCooldown(key: string): void {
  cooldowns.set(key, Date.now() + COOLDOWN_MS)
}

export function resetAllCooldowns(): void {
  cooldowns.clear()
  currentIndex = 0
}

function isTokenHarborRequest(request: Request): boolean {
  try {
    const hostname = new URL(request.url).hostname.toLowerCase()
    return hostname === TOKEN_HARBOR_HOST || hostname.endsWith(`.${TOKEN_HARBOR_HOST}`)
  } catch {
    return false
  }
}

export const SimplyRouter: Plugin = {
  id: "simply-router",
  setup: async (ctx) => {
    const selectedKeys = new WeakMap<Request, string>()

    const registrations = await Promise.all([
      ctx.session.hook("http.request", async ({ request }) => {
        if (!isTokenHarborRequest(request)) return

        const selected = getNextAvailableKey()
        if (!selected) {
          console.error("simply-router: all API keys are cooling down; use /simplyrouter reset.")
          return
        }

        request.headers.set("Authorization", `Bearer ${selected.key}`)
        selectedKeys.set(request, selected.key)
        console.info(`simply-router: selected key #${selected.index + 1}.`)
      }),
      ctx.session.hook("http.response", async ({ request, response }) => {
        if (!isTokenHarborRequest(request)) return
        if (response.status !== 429 && response.status !== 401 && response.status !== 403) return

        const key = selectedKeys.get(request)
        if (!key) return

        selectedKeys.delete(request)
        markKeyCooldown(key)
        console.warn(
          `simply-router: key #${KEYS.indexOf(key) + 1} is cooling down for seven days (HTTP ${response.status}).`,
        )
      }),
      ctx.tool.transform((tools) => {
        tools.add({
          name: "simplyrouter_reset",
          description: "Clear all simply-router API-key cooldowns and restart key rotation.",
          input: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          execute: async () => {
            resetAllCooldowns()
            console.info("simply-router: all cooldowns cleared and key rotation reset.")
            return { content: "simply-router cooldowns cleared; key rotation reset." }
          },
        })
      }),
      ctx.command.transform((commands) => {
        commands.add({
          name: "simplyrouter",
          description: "Manage simply-router API-key cooldowns. Usage: /simplyrouter reset",
          execute: async ({ prompt }) => {
            if (prompt.text.trim().toLowerCase() !== "reset") {
              console.info("simply-router: use /simplyrouter reset to clear all key cooldowns.")
              return
            }

            resetAllCooldowns()
            console.info("simply-router: all cooldowns cleared and key rotation reset.")
          },
        })
      }),
    ])

    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()))
    }
  },
}
