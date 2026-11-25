import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import {
  COOLDOWN_MS,
  getNextAvailableKey,
  KEYS,
  markKeyCooldown,
  resetAllCooldowns,
} from "../src/main"

describe("simply-router key selection", () => {
  let now: number

  beforeEach(() => {
    now = 1_000_000
    spyOn(Date, "now").mockImplementation(() => now)
    resetAllCooldowns()
  })

  afterEach(() => {
    mock.restore()
  })

  test("selects key 0 initially", () => {
    expect(getNextAvailableKey()?.key).toBe(KEYS[0])
  })

  test("selects key 1 when key 0 is cooling down", () => {
    markKeyCooldown(KEYS[0])

    expect(getNextAvailableKey()?.key).toBe(KEYS[1])
  })

  test("returns null when every key is cooling down", () => {
    for (const key of KEYS) markKeyCooldown(key)

    expect(getNextAvailableKey()).toBeNull()
  })

  test("makes an expired cooldown available at its expiration boundary", () => {
    markKeyCooldown(KEYS[0])
    now += COOLDOWN_MS

    expect(getNextAvailableKey()?.key).toBe(KEYS[0])
  })

  test("reset clears cooldowns and restores the initial index", () => {
    markKeyCooldown(KEYS[0])
    expect(getNextAvailableKey()?.key).toBe(KEYS[1])

    resetAllCooldowns()

    expect(getNextAvailableKey()?.key).toBe(KEYS[0])
  })

  test("markKeyCooldown expires at Date.now() plus seven days", () => {
    for (const key of KEYS) markKeyCooldown(key)
    expect(COOLDOWN_MS).toBe(604_800_000)

    now += 604_800_000 - 1
    expect(getNextAvailableKey()).toBeNull()

    now += 1
    expect(getNextAvailableKey()?.key).toBe(KEYS[0])
  })
})
