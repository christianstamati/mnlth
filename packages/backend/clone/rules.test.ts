import { describe, expect, test } from "bun:test"
import schema from "../convex/schema"
import { rules } from "./rules"

// A table added to the schema without a rule would leave the box untouched.
// Fail here, in CI, instead of at the first clone.
describe("clone rules", () => {
  const tables = Object.keys(schema.tables)

  test.each(tables)("cover table %s", (table) => {
    expect(rules[table]).toBeDefined()
  })

  test("name only tables the schema has", () => {
    for (const table of Object.keys(rules)) {
      expect(tables).toContain(table)
    }
  })
})
