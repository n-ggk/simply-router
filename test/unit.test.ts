import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COOLDOWN_MS,
  createRotator,
  getNextAvailableKey,
  hasAvailableKey,
  loadProviderKeys,
  markKeyCooldown,
  parseMaxRetries,
  persistProviderKeyCooldown,
  resetProviderKeyFiles,
  resetRotator,
} from "../src/main"

const KEYS = ["key-0", "key-1", "key-2"]

function writeKeyFile(directory: string, provider: string, records: unknown[]): void {
  writeFileSync(join(directory, `${provider}.ts`), `export default ${JSON.stringify(records, null, 2)} as const;\n`, "utf8")
}

describe("simply-router key rotation", () => {
  let now: number

  beforeEach(() => {
    now = 1_000_000
    spyOn(Date, "now").mockImplementation(() => now)
  })

  afterEach(() => {
    mock.restore()
  })

  test("selects the first key initially", () => {
    const rotator = createRotator(KEYS)
    expect(getNextAvailableKey(rotator)?.key).toBe(KEYS[0])
  })

  test("skips a key that is cooling down", () => {
    const rotator = createRotator(KEYS)
    markKeyCooldown(rotator, KEYS[0])

    expect(getNextAvailableKey(rotator)?.key).toBe(KEYS[1])
  })

  test("returns null when every key is cooling down", () => {
    const rotator = createRotator(KEYS)
    for (const key of KEYS) markKeyCooldown(rotator, key)

    expect(getNextAvailableKey(rotator)).toBeNull()
  })

  test("an expired cooldown is available at its exact expiration boundary", () => {
    const rotator = createRotator(KEYS)
    markKeyCooldown(rotator, KEYS[0])
    now += COOLDOWN_MS

    expect(getNextAvailableKey(rotator)?.key).toBe(KEYS[0])
  })

  test("reset clears cooldowns and restores the initial index", () => {
    const rotator = createRotator(KEYS)
    markKeyCooldown(rotator, KEYS[0])
    expect(getNextAvailableKey(rotator)?.key).toBe(KEYS[1])

    resetRotator(rotator)

    expect(getNextAvailableKey(rotator)?.key).toBe(KEYS[0])
  })

  test("cooldown lasts exactly seven days", () => {
    expect(COOLDOWN_MS).toBe(604_800_000)

    const rotator = createRotator(KEYS)
    for (const key of KEYS) markKeyCooldown(rotator, key)

    now += 604_800_000 - 1
    expect(getNextAvailableKey(rotator)).toBeNull()

    now += 1
    expect(getNextAvailableKey(rotator)?.key).toBe(KEYS[0])
  })

  test("hasAvailableKey is true when at least one key is fresh", () => {
    const rotator = createRotator(KEYS)
    expect(hasAvailableKey(rotator)).toBe(true)
  })

  test("hasAvailableKey is false when every key is cooling down", () => {
    const rotator = createRotator(KEYS)
    for (const key of KEYS) markKeyCooldown(rotator, key)

    expect(hasAvailableKey(rotator)).toBe(false)
  })

  test("hasAvailableKey is true again at the expiration boundary", () => {
    const rotator = createRotator(KEYS)
    for (const key of KEYS) markKeyCooldown(rotator, key)
    now += COOLDOWN_MS

    expect(hasAvailableKey(rotator)).toBe(true)
  })
})

describe("simply-router retry cap", () => {
  test("parseMaxRetries accepts positive integers", () => {
    expect(parseMaxRetries(3)).toBe(3)
    expect(parseMaxRetries("5")).toBe(5)
    expect(parseMaxRetries("2.9")).toBe(2)
  })

  test("parseMaxRetries rejects missing or non-positive values", () => {
    expect(parseMaxRetries(0)).toBeUndefined()
    expect(parseMaxRetries(-1)).toBeUndefined()
    expect(parseMaxRetries("abc")).toBeUndefined()
    expect(parseMaxRetries(undefined)).toBeUndefined()
    expect(parseMaxRetries(null)).toBeUndefined()
  })
})

describe("simply-router provider key loading", () => {
  test("reads free keys from <provider>.ts and ignores other files", () => {
    const dir = mkdtempSync(join(tmpdir(), "simply-router-"))
    try {
      writeKeyFile(dir, "tokenharbor", [
        { key: "key-a", status: "free" },
        { key: "key-b", status: "free" },
        { key: "key-c", status: "cooldown", cooldownUntil: new Date(Date.now() + COOLDOWN_MS).toISOString() },
      ])
      writeFileSync(join(dir, "ignored.txt"), "not loaded", "utf8")
      writeFileSync(join(dir, "notes.md"), "ignored", "utf8")

      const providers = loadProviderKeys(dir)

      expect([...providers.keys()]).toEqual(["tokenharbor"])
      expect(providers.get("tokenharbor")).toEqual(["key-a", "key-b"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("expired cooldowns are persisted as free before keys are returned", () => {
    const dir = mkdtempSync(join(tmpdir(), "simply-router-"))
    try {
      writeKeyFile(dir, "tokenharbor", [
        { key: "expired-key", status: "cooldown", cooldownUntil: new Date(1_000).toISOString() },
        { key: "active-key", status: "cooldown", cooldownUntil: new Date(10_000).toISOString() },
      ])

      expect(loadProviderKeys(dir, 1_000).get("tokenharbor")).toEqual(["expired-key"])
      const saved = readFileSync(join(dir, "tokenharbor.ts"), "utf8")
      expect(saved).toContain('"key": "expired-key",\n    "status": "free"')
      expect(saved).toContain('"key": "active-key",\n    "status": "cooldown"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("does not count any number of cooldown keys against free-key selection", () => {
    const dir = mkdtempSync(join(tmpdir(), "simply-router-"))
    try {
      const cooldownUntil = new Date(Date.now() + COOLDOWN_MS).toISOString()
      writeKeyFile(dir, "tokenharbor", [
        ...Array.from({ length: 15 }, (_, index) => ({
          key: `cooldown-${index}`,
          status: "cooldown",
          cooldownUntil,
        })),
        { key: "available", status: "free" },
      ])

      const providers = loadProviderKeys(dir)
      expect(getNextAvailableKey(createRotator(providers.get("tokenharbor") ?? []))?.key).toBe("available")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("persists a seven-day cooldown and reset restores keys to free", () => {
    const dir = mkdtempSync(join(tmpdir(), "simply-router-"))
    try {
      writeKeyFile(dir, "tokenharbor", [{ key: "key-a", status: "free" }])

      persistProviderKeyCooldown(dir, "tokenharbor", "key-a", 1_000)

      expect(loadProviderKeys(dir, 1_000 + COOLDOWN_MS - 1).get("tokenharbor")).toEqual([])
      expect(loadProviderKeys(dir, 1_000 + COOLDOWN_MS).get("tokenharbor")).toEqual(["key-a"])

      persistProviderKeyCooldown(dir, "tokenharbor", "key-a", 1_000)
      resetProviderKeyFiles(dir)
      expect(loadProviderKeys(dir, 1_000).get("tokenharbor")).toEqual(["key-a"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns an empty map when the directory does not exist", () => {
    expect(loadProviderKeys(join(tmpdir(), "simply-router-missing-dir")).size).toBe(0)
  })
})
