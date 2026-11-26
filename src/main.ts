import type { Plugin } from "@opencode/plugin/promise/plugin"
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

/** Default keys directory: one `<provider>.ts` file per provider. */
export const DEFAULT_KEYS_DIR = join(homedir(), "tokenharbor", "keys")

type ProviderKeyRecord =
  | { key: string; status: "free" }
  | { key: string; status: "cooldown"; cooldownUntil: string }

const KEY_FILE_PREFIX = "export default "
const KEY_FILE_SUFFIX = " as const;"

/** Env name referenced by `opencode.json` as `{env:MY_API_KEY-<provider>}`. */
const ENV_PREFIX = "MY_API_KEY-"

/**
 * Tracing is opt-in. Set `SIMPLY_ROUTER_TRACE=1` to append one line per native
 * HTTP request and per retry decision. Override the path with
 * `SIMPLY_ROUTER_TRACE_FILE`.
 */
const TRACE = process.env.SIMPLY_ROUTER_TRACE === "1" || process.env.SIMPLY_ROUTER_TRACE === "true"
const TRACE_FILE = process.env.SIMPLY_ROUTER_TRACE_FILE ?? join(tmpdir(), "simply-router-trace.log")

function trace(message: string): void {
  if (!TRACE) return
  try {
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} simply-router: ${message}\n`)
  } catch {
    // Tracing must never break request handling.
  }
}

/** Round-robin key state for one provider. */
export interface Rotator {
  keys: readonly string[]
  readonly cooldowns: Map<string, number>
  currentIndex: number
}

export function createRotator(keys: readonly string[]): Rotator {
  return { keys, cooldowns: new Map(), currentIndex: 0 }
}

export function getNextAvailableKey(rotator: Rotator): { key: string; index: number } | null {
  const now = Date.now()
  const { keys } = rotator

  for (let offset = 0; offset < keys.length; offset++) {
    const index = (rotator.currentIndex + offset) % keys.length
    const key = keys[index]
    const cooldownUntil = rotator.cooldowns.get(key)

    if (cooldownUntil === undefined || now >= cooldownUntil) {
      if (cooldownUntil !== undefined) rotator.cooldowns.delete(key)
      rotator.currentIndex = (index + 1) % keys.length
      return { key, index }
    }
  }

  return null
}

export function markKeyCooldown(rotator: Rotator, key: string): void {
  rotator.cooldowns.set(key, Date.now() + COOLDOWN_MS)
}

export function resetRotator(rotator: Rotator): void {
  rotator.cooldowns.clear()
  rotator.currentIndex = 0
}

function isCoolingDown(rotator: Rotator, key: string, now: number = Date.now()): boolean {
  const cooldownUntil = rotator.cooldowns.get(key)
  return cooldownUntil !== undefined && now < cooldownUntil
}

export function hasAvailableKey(rotator: Rotator, now: number = Date.now()): boolean {
  return rotator.keys.some((key) => !isCoolingDown(rotator, key, now))
}

function readProviderKeyRecords(filePath: string): ProviderKeyRecord[] {
  const contents = readFileSync(filePath, "utf8").trim()
  if (!contents.startsWith(KEY_FILE_PREFIX) || !contents.endsWith(KEY_FILE_SUFFIX)) {
    throw new Error(`expected a TypeScript key file using "${KEY_FILE_PREFIX}[...]${KEY_FILE_SUFFIX}"`)
  }

  const serialized = contents.slice(KEY_FILE_PREFIX.length, -KEY_FILE_SUFFIX.length).trim()
  const parsed: unknown = JSON.parse(serialized)
  if (!Array.isArray(parsed)) throw new Error("expected the default export to be an array")

  return parsed.map((entry: unknown, index: number): ProviderKeyRecord => {
    if (typeof entry !== "object" || entry === null || !("key" in entry) || !("status" in entry)) {
      throw new Error(`invalid key entry at index ${index}`)
    }

    if (typeof entry.key !== "string" || entry.key.trim().length === 0) {
      throw new Error(`invalid key at index ${index}`)
    }
    if (entry.status === "free") return { key: entry.key, status: "free" }
    if (
      entry.status === "cooldown" &&
      "cooldownUntil" in entry &&
      typeof entry.cooldownUntil === "string" &&
      Number.isFinite(Date.parse(entry.cooldownUntil))
    ) {
      return { key: entry.key, status: "cooldown", cooldownUntil: entry.cooldownUntil }
    }
    throw new Error(`invalid status or cooldownUntil at index ${index}`)
  })
}

function writeProviderKeyRecords(filePath: string, records: readonly ProviderKeyRecord[]): void {
  writeFileSync(filePath, `${KEY_FILE_PREFIX}${JSON.stringify(records, null, 2)}${KEY_FILE_SUFFIX}\n`, "utf8")
}

function loadProviderKeyFile(filePath: string, now: number): string[] {
  let records = readProviderKeyRecords(filePath)
  let expired = false
  const refreshed = records.map((record) => {
    if (record.status !== "cooldown" || Date.parse(record.cooldownUntil) > now) return record
    expired = true
    return { key: record.key, status: "free" } satisfies ProviderKeyRecord
  })

  if (expired) {
    writeProviderKeyRecords(filePath, refreshed)
    records = readProviderKeyRecords(filePath)
  }

  return records.filter((record) => record.status === "free").map((record) => record.key)
}

/** Reads each `<provider>.ts` file and returns only keys whose status is free. */
export function loadProviderKeys(directory: string, now: number = Date.now()): Map<string, string[]> {
  const providers = new Map<string, string[]>()

  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return providers
    }
    console.error(`simply-router: failed to read keys directory ${directory}: ${error}`)
    return providers
  }

  for (const entry of entries) {
    if (!/\.ts$/i.test(entry)) continue
    const providerID = entry.replace(/\.ts$/i, "")
    try {
      providers.set(providerID, loadProviderKeyFile(join(directory, entry), now))
    } catch (error) {
      console.error(`simply-router: failed to load ${entry}: ${error}`)
      providers.set(providerID, [])
    }
  }

  return providers
}

export function persistProviderKeyCooldown(
  directory: string,
  providerID: string,
  key: string,
  now: number = Date.now(),
): void {
  const filePath = join(directory, `${providerID}.ts`)
  const records = readProviderKeyRecords(filePath)
  let found = false
  const cooldownUntil = new Date(now + COOLDOWN_MS).toISOString()
  const updated = records.map((record) => {
    if (record.key !== key) return record
    found = true
    return { key: record.key, status: "cooldown", cooldownUntil } satisfies ProviderKeyRecord
  })
  if (!found) throw new Error(`key was not found in ${filePath}`)
  writeProviderKeyRecords(filePath, updated)
}

export function resetProviderKeyFiles(directory: string): void {
  for (const entry of readdirSync(directory).filter((name) => /\.ts$/i.test(name))) {
    const filePath = join(directory, entry)
    const records = readProviderKeyRecords(filePath)
    writeProviderKeyRecords(
      filePath,
      records.map((record) => ({ key: record.key, status: "free" })),
    )
  }
}

function isFailureStatus(status: number | undefined): status is 429 | 401 | 403 {
  return status === 429 || status === 401 || status === 403
}

/**
 * Providers report a per-account allowance exhaustion as a 429 with a long
 * `retryAfterMs` and a message that may carry no status.
 */
function isRateLimitMessage(message: string): boolean {
  return /rate ?limit|allowance|too many/i.test(message)
}

/**
 * Reads a positive integer retry cap. Returns `undefined` for missing or invalid
 * values, so the caller falls back to the provider's key count.
 */
export function parseMaxRetries(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined
}

export const SimplyRouter: Plugin = {
  id: "simply-router",
  setup: async (ctx) => {
    const options = (ctx.options ?? {}) as Record<string, unknown>
    const configuredMaxRetries = parseMaxRetries(options.maxRetries ?? process.env.SIMPLY_ROUTER_MAX_RETRIES)
    const storedDir = await ctx.storage.get("keysDir")
    let keysDir =
      (typeof options.keysDir === "string" ? options.keysDir : undefined) ??
      (typeof storedDir === "string" ? storedDir : undefined) ??
      process.env.SIMPLY_ROUTER_KEYS_DIR ??
      DEFAULT_KEYS_DIR

    const rotators = new Map<string, Rotator>()

    /** (Re)loads every provider found in `directory` into the shared rotators map. */
    const applyKeysDir = (directory: string): { providers: number; keys: number } => {
      const providers = loadProviderKeys(directory)
      rotators.clear()
      let keyCount = 0

      for (const [providerID, keys] of providers) {
        rotators.set(providerID, createRotator(keys))
        keyCount += keys.length
        // Make the `{env:MY_API_KEY-<provider>}` reference in opencode.json resolve.
        const envName = ENV_PREFIX + providerID
        if (keys[0] && !process.env[envName]) process.env[envName] = keys[0]
      }

      return { providers: providers.size, keys: keyCount }
    }

    const refreshProviderKeys = (providerID: string, rotator: Rotator): void => {
      try {
        rotator.keys = loadProviderKeyFile(join(keysDir, `${providerID}.ts`), Date.now())
        if (rotator.keys.length > 0) rotator.currentIndex %= rotator.keys.length
        else rotator.currentIndex = 0
      } catch (error) {
        rotator.keys = []
        rotator.currentIndex = 0
        console.error(`simply-router: failed to refresh ${providerID}.ts: ${error}`)
      }
    }

    const resetAllCooldowns = (): void => {
      try {
        resetProviderKeyFiles(keysDir)
        applyKeysDir(keysDir)
      } catch (error) {
        for (const rotator of rotators.values()) resetRotator(rotator)
        console.error(`simply-router: failed to reset key files in ${keysDir}: ${error}`)
      }
    }

    const initial = applyKeysDir(keysDir)
    if (initial.providers === 0) {
      console.warn(`simply-router: no "<provider>.ts" key files found in ${keysDir}; no provider will be rotated.`)
    } else {
      console.info(`simply-router: rotating ${initial.providers} provider(s), ${initial.keys} key(s) from ${keysDir}.`)
    }

    // Tracks the key in use for each in-flight native Request, so the response
    // handler cools down the exact key that failed.
    const selectedByRequest = new WeakMap<Request, { providerID: string; key: string; index: number }>()

    const coolDown = (providerID: string, rotator: Rotator, failed: { key: string; index: number }, status: number): void => {
      if (isCoolingDown(rotator, failed.key)) return
      markKeyCooldown(rotator, failed.key)
      try {
        persistProviderKeyCooldown(keysDir, providerID, failed.key)
      } catch (error) {
        console.error(`simply-router: failed to persist cooldown for ${providerID} key #${failed.index + 1}: ${error}`)
      }
      console.warn(
        `simply-router: ${providerID} key #${failed.index + 1} is cooling down for seven days (HTTP ${status}).`,
      )
    }

    const registrations = await Promise.all([
      ctx.session.hook("http.request", async ({ model, kind, request }) => {
        const rotator = rotators.get(model.providerID)
        if (!rotator) return
        refreshProviderKeys(model.providerID, rotator)

        const selected = getNextAvailableKey(rotator)
        if (!selected) {
          request.headers.delete("Authorization")
          console.error(`simply-router: every ${model.providerID} key is cooling down; use /simplyrouter reset.`)
          return
        }

        request.headers.set("Authorization", `Bearer ${selected.key}`)
        selectedByRequest.set(request, { providerID: model.providerID, ...selected })
        console.info(`simply-router: ${model.providerID} selected key #${selected.index + 1}.`)
        trace(`http.request provider=${model.providerID} kind=${kind} key=#${selected.index + 1}`)
      }),
      // The failed key is benched here, before the retry is scheduled, so the
      // retry's own http.request picks a different key.
      ctx.session.hook("http.response", async ({ model, request, response }) => {
        const rotator = rotators.get(model.providerID)
        if (!rotator) return
        if (!isFailureStatus(response.status)) return

        const failed = selectedByRequest.get(request)
        if (!failed || failed.providerID !== model.providerID) return

        selectedByRequest.delete(request)
        coolDown(model.providerID, rotator, failed, response.status)
        trace(`http.response provider=${model.providerID} status=${response.status} cooled-#${failed.index + 1}`)
      }),
      // The retry hook is the last step before the next physical attempt. The
      // provider asks for a long wait because the *account* is rate limited, but
      // the retry runs on a different key, so the wait is pointless: retry at
      // once. When no key is left, veto the retry. `attempt` starts at 2 for the
      // first retry and there are rotator.keys.length keys to try.
      ctx.session.hook("retry", (event) => {
        const rotator = rotators.get(event.model.providerID)
        if (!rotator) return
        refreshProviderKeys(event.model.providerID, rotator)

        const status = event.error.status
        const failure = isFailureStatus(status) || isRateLimitMessage(event.error.message)
        trace(
          `retry provider=${event.model.providerID} attempt=${event.attempt} status=${status ?? "none"} ` +
            `type=${event.error.type} proposed-delay=${event.decision.retry ? event.decision.delay : "no-retry"}`,
        )

        if (!failure) return

        if (!hasAvailableKey(rotator)) {
          event.decision = { retry: false }
          console.warn(`simply-router: no ${event.model.providerID} key is available; the request will not be retried.`)
          trace(`retry attempt=${event.attempt} -> veto (no key)`)
          return
        }

        // One immediate retry per key by default (attempts 2..keys.length); a
        // configured `maxRetries` overrides that cap.
        const maxAttempts = configuredMaxRetries ?? rotator.keys.length
        if (event.attempt <= maxAttempts) {
          event.decision = { retry: true, delay: 0 }
          console.info(`simply-router: retrying ${event.model.providerID} immediately on a fresh key.`)
          trace(`retry attempt=${event.attempt} -> delay=0 (fresh key, max=${maxAttempts})`)
          return
        }

        event.decision = { retry: false }
        console.warn(`simply-router: every ${event.model.providerID} key failed for this request; giving up.`)
        trace(`retry attempt=${event.attempt} -> veto (keys exhausted)`)
      }),
      ctx.tool.transform((tools) => {
        tools.add({
          name: "simplyrouter_reset",
          description: "Clear all simply-router API-key cooldowns and restart key rotation for every provider.",
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
          description: "Manage simply-router. Usage: /simplyrouter reset | /simplyrouter -keydirectory-set <path>",
          execute: async ({ sessionID, prompt }) => {
            const text = prompt.text.trim()

            const match = /^-?keydirectory-set\b\s*(.*)$/i.exec(text)
            if (match) {
              const raw = match[1].trim().replace(/^"(.*)"$/, "$1")

              if (!raw) {
                await ctx.session.synthetic({
                  sessionID,
                  text: `simply-router: current key directory is ${keysDir}`,
                })
                return
              }

              let isDirectory = false
              try {
                isDirectory = statSync(raw).isDirectory()
              } catch {
                isDirectory = false
              }
              if (!isDirectory) {
                await ctx.session.synthetic({
                  sessionID,
                  text: `simply-router: not a directory, nothing changed: ${raw}`,
                })
                return
              }

              keysDir = raw
              const loaded = applyKeysDir(keysDir)
              await ctx.storage.set("keysDir", raw)
              console.info(
                `simply-router: key directory set to ${raw} (${loaded.providers} provider(s), ${loaded.keys} key(s)).`,
              )
              await ctx.session.synthetic({
                sessionID,
                text:
                  `simply-router: key directory set to ${raw} — ` +
                  `${loaded.providers} provider(s), ${loaded.keys} key(s) loaded.`,
              })
              return
            }

            if (text.toLowerCase() === "reset") {
              resetAllCooldowns()
              console.info("simply-router: all cooldowns cleared and key rotation reset.")
              await ctx.session.synthetic({
                sessionID,
                text: "simply-router: all cooldowns cleared; key rotation reset.",
              })
              return
            }

            await ctx.session.synthetic({
              sessionID,
              text: "simply-router: usage — /simplyrouter reset | /simplyrouter -keydirectory-set <path>",
            })
          },
        })
      }),
    ])

    return async () => {
      await Promise.all(registrations.map((registration) => registration.dispose()))
    }
  },
}
