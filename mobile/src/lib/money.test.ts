import { describe, expect, it } from "vitest"

import {
  formatClpInputValue,
  normalizeEditableClpText,
  parseClpInputText,
} from "@/lib/money"

describe("CLP input formatting", () => {
  it.each([
    [null, ""],
    [0, "0"],
    [1_000, "1.000"],
    [1_500_000, "1.500.000"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatClpInputValue(value)).toBe(expected)
  })

  it("normalizes entered thousands separators", () => {
    expect(parseClpInputText("1.500.000")).toEqual({
      valid: true,
      value: 1_500_000,
      text: "1.500.000",
    })
    expect(parseClpInputText("1500000")).toEqual({
      valid: true,
      value: 1_500_000,
      text: "1.500.000",
    })
  })

  it("normalizes incomplete grouping produced during live editing", () => {
    expect(normalizeEditableClpText("70.00")).toEqual({
      valid: true,
      value: 7_000,
      text: "7.000",
    })
    expect(normalizeEditableClpText("1.500.000")).toEqual({
      valid: true,
      value: 1_500_000,
      text: "1.500.000",
    })
  })

  it("keeps empty and zero as distinct valid values", () => {
    expect(parseClpInputText("")).toEqual({ valid: true, value: null, text: "" })
    expect(parseClpInputText("0")).toEqual({ valid: true, value: 0, text: "0" })
  })

  it.each(["abc", "12abc", "1,5", "1.5", "1.000,50"])(
    "rejects invalid or decimal text: %s",
    (input) => {
      expect(parseClpInputText(input)).toEqual({
        valid: false,
        value: null,
        text: "",
      })
    },
  )

  it("rejects negatives by default and accepts them when configured", () => {
    expect(parseClpInputText("-1000").valid).toBe(false)
    expect(parseClpInputText("-1.000", { allowNegative: true })).toEqual({
      valid: true,
      value: -1_000,
      text: "-1.000",
    })
    expect(formatClpInputValue(-1_000, { allowNegative: true })).toBe("-1.000")
  })

  it("never converts unsafe input into NaN", () => {
    const result = parseClpInputText("999999999999999999999999")
    expect(result.valid).toBe(false)
    expect(Number.isNaN(result.value)).toBe(false)
  })
})
