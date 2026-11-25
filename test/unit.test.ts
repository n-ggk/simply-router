import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  COOLDOWN_MS,
  createRotator,
  getNextAvailableKey,
  hasAvailableKey,
  loadProviderKeys,
  markKeyCooldown,
  resetRotator,
} from "../src/main"

const KEYS = ["key-0", "key-1", "key-2"]

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

describe("simply-router provider key loading", () => {
  test("reads <provider>.txt, one key per line, and ignores other files", () => {
    const dir = mkdtempSync(join(tmpdir(), "simply-router-"))
    try {
      writeFileSync(join(dir, "tokenharbor.txt"), "key-a\nkey-b\n\n", "utf8")
      writeFileSync(join(dir, "notes.md"), "ignored", "utf8")

      const providers = loadProviderKeys(dir)

      expect([...providers.keys()]).toEqual(["tokenharbor"])
      expect(providers.get("tokenharbor")).toEqual(["key-a", "key-b"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns an empty map when the directory does not exist", () => {
    expect(loadProviderKeys(join(tmpdir(), "simply-router-missing-dir")).size).toBe(0)
  })
})
