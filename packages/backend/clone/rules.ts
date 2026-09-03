/**
 * What `bun run convex:clone` does to each field of a snapshot before it is
 * imported anywhere. Read by `scripts/clone/anonymize.ts`. Kept
 * dependency-free so it can be applied to an export by hand, anywhere.
 *
 * Every table in `convex/schema.ts` needs an entry (`rules.test.ts` fails
 * otherwise), and every table found in an export needs one too (the
 * anonymizer aborts otherwise). A table nobody has thought about never
 * leaves the box by accident.
 *
 * Strategies:
 *   keep    copy the value as is
 *   hash    replace with `anon_<hmac>`; the same input gives the same output
 *           within one clone, so references between documents survive
 *   email   `<hmac>@example.com`, stable like `hash`
 *   name    a fake "First Last", stable like `hash`
 *   redact  the fixed string "[redacted]"
 *   remove  delete the field; the schema field has to be optional
 *   file    a `v.id("_storage")` reference: kept when the clone includes
 *           file storage, removed otherwise (so also needs to be optional)
 *
 * A dotted key (`address.city`) reaches into a nested object. Fields not
 * listed are copied unchanged, so list every field that holds personal
 * data. `_id` and `_creationTime` are never touched: the import needs them.
 */

export type Strategy =
  | "keep"
  | "hash"
  | "email"
  | "name"
  | "redact"
  | "remove"
  | "file"

/** `drop` leaves the table out of the snapshot entirely. */
export type TableRule = { drop: true } | { fields: Record<string, Strategy> }

export const rules: Record<string, TableRule> = {
  messages: {
    fields: {
      user: "hash",
      username: "name",
      body: "redact",
    },
  },
}
