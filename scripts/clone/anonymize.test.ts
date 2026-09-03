import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Rules } from "./anonymize"
import { Anonymizer, anonymizeExport } from "./anonymize"

const salt = Buffer.alloc(32, 1)

describe("Anonymizer", () => {
  const a = new Anonymizer(salt)

  test("is deterministic within a salt and differs across salts", () => {
    const b = new Anonymizer(Buffer.alloc(32, 2))
    expect(a.hash("alice")).toBe(a.hash("alice"))
    expect(a.hash("alice")).not.toBe(a.hash("bob"))
    expect(a.hash("alice")).not.toBe(b.hash("alice"))
  })

  test("produces obviously fake shapes", () => {
    expect(a.hash("x")).toMatch(/^anon_[0-9a-f]{24}$/)
    expect(a.email("x@real.com")).toMatch(/^[0-9a-f]{16}@example\.com$/)
    expect(a.name("Christian Stamati")).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  })

  test("applies each strategy and reaches nested fields", () => {
    const doc = a.document(
      {
        _id: "id1",
        _creationTime: 1,
        user: "u1",
        mail: "me@real.com",
        name: "Me",
        body: "secret",
        note: "gone",
        avatar: "storage1",
        profile: { city: "Berlin", zip: "10115" },
      },
      {
        user: "hash",
        mail: "email",
        name: "name",
        body: "redact",
        note: "remove",
        avatar: "file",
        "profile.city": "redact",
        "profile.zip": "keep",
        missing: "redact",
      },
      false
    )
    expect(doc._id).toBe("id1")
    expect(doc._creationTime).toBe(1)
    expect(doc.user).toBe(a.hash("u1"))
    expect(doc.mail).toBe(a.email("me@real.com"))
    expect(doc.name).toBe(a.name("Me"))
    expect(doc.body).toBe("[redacted]")
    expect("note" in doc).toBe(false)
    expect("avatar" in doc).toBe(false)
    expect(doc.profile).toEqual({ city: "[redacted]", zip: "10115" })
    expect("missing" in doc).toBe(false)
  })

  test("keeps file references when file storage is included", () => {
    const doc = a.document({ avatar: "storage1" }, { avatar: "file" }, true)
    expect(doc.avatar).toBe("storage1")
  })

  test("refuses rules on system fields", () => {
    expect(() => a.document({ _id: "x" }, { _id: "hash" }, false)).toThrow()
  })
})

describe("anonymizeExport", () => {
  let dir: string

  async function table(name: string, docs: object[]) {
    await mkdir(join(dir, name), { recursive: true })
    await writeFile(
      join(dir, name, "documents.jsonl"),
      docs.map((d) => JSON.stringify(d)).join("\n")
    )
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clone-"))
    await table("_tables", [{ name: "messages", id: 1 }])
    await table("messages", [
      { _id: "m1", _creationTime: 1, user: "alice", body: "hi" },
      { _id: "m2", _creationTime: 2, user: "alice", body: "again" },
      { _id: "m3", _creationTime: 3, user: "bob", body: "hello" },
    ])
    await table("secrets", [{ _id: "s1", _creationTime: 1, token: "t" }])
    await mkdir(join(dir, "_storage"))
    await writeFile(join(dir, "_storage", "documents.jsonl"), "{}\n")
    await writeFile(join(dir, "_storage", "file1"), "bytes")
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const rules: Rules = {
    messages: { fields: { user: "hash", body: "redact" } },
    secrets: { drop: true },
  }

  async function read(name: string) {
    const text = await Bun.file(join(dir, name, "documents.jsonl")).text()
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  }

  test("rewrites, drops, and removes file storage by default", async () => {
    const report = await anonymizeExport(dir, rules, {
      includeFileStorage: false,
      salt,
    })
    expect(report).toEqual({
      rewritten: { messages: 3 },
      dropped: ["secrets"],
      fileStorage: "dropped",
    })

    const docs = await read("messages")
    expect(docs.map((d) => d._id)).toEqual(["m1", "m2", "m3"])
    expect(docs.every((d) => d.body === "[redacted]")).toBe(true)
    // Same author, same pseudonym: references between rows survive.
    expect(docs[0].user).toBe(docs[1].user)
    expect(docs[0].user).not.toBe(docs[2].user)
    expect(docs[0].user).not.toBe("alice")

    expect(existsSync(join(dir, "secrets"))).toBe(false)
    expect(existsSync(join(dir, "_storage"))).toBe(false)
    expect(existsSync(join(dir, "_tables", "documents.jsonl"))).toBe(true)
  })

  test("keeps file storage on request", async () => {
    const report = await anonymizeExport(dir, rules, {
      includeFileStorage: true,
      salt,
    })
    expect(report.fileStorage).toBe("kept")
    expect(existsSync(join(dir, "_storage", "file1"))).toBe(true)
  })

  test("aborts before rewriting when a table has no rule", async () => {
    await table("orphans", [{ _id: "o1", _creationTime: 1, email: "x" }])
    await expect(
      anonymizeExport(dir, rules, { includeFileStorage: false, salt })
    ).rejects.toThrow(/orphans/)
    // Nothing was touched.
    const docs = await read("messages")
    expect(docs[0].user).toBe("alice")
    expect(existsSync(join(dir, "secrets"))).toBe(true)
  })

  test("handles a table with a missing or empty documents file", async () => {
    await mkdir(join(dir, "empty"))
    const report = await anonymizeExport(
      dir,
      { ...rules, empty: { fields: {} } },
      { includeFileStorage: false, salt }
    )
    expect(report.rewritten.empty).toBe(0)
  })
})
