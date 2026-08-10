import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SeenStore } from "./seenStore.js";

function tempPath(name: string): string {
  return join(tmpdir(), `seen-store-test-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("SeenStore: a collection with no persisted entry is reported as new", () => {
  const path = tempPath("new-collection");
  try {
    const store = new SeenStore(path);
    assert.equal(store.isNewCollection("0xabc"), true);
    assert.deepEqual([...store.getListingIds("0xabc")], []);
    assert.deepEqual([...store.getSaleIds("0xabc")], []);
  } finally {
    rmSync(path, { force: true });
  }
});

test("SeenStore: recordSeen makes a collection no longer new, and its IDs retrievable", () => {
  const path = tempPath("record-seen");
  try {
    const store = new SeenStore(path);
    store.recordSeen("0xabc", { listingIds: ["l1", "l2"], saleIds: ["s1"] });

    assert.equal(store.isNewCollection("0xabc"), false);
    assert.deepEqual([...store.getListingIds("0xabc")].sort(), ["l1", "l2"]);
    assert.deepEqual([...store.getSaleIds("0xabc")], ["s1"]);
  } finally {
    rmSync(path, { force: true });
  }
});

test("SeenStore: persists across instances (restart simulation) — a fresh instance reads what a prior one wrote", () => {
  const path = tempPath("restart-sim");
  try {
    const first = new SeenStore(path);
    first.recordSeen("0xabc", { listingIds: ["l1"], saleIds: ["s1", "s2"] });

    const second = new SeenStore(path);
    assert.equal(second.isNewCollection("0xabc"), false);
    assert.deepEqual([...second.getListingIds("0xabc")], ["l1"]);
    assert.deepEqual([...second.getSaleIds("0xabc")].sort(), ["s1", "s2"]);
  } finally {
    rmSync(path, { force: true });
  }
});

test("SeenStore: recordSeen merges with (doesn't replace) previously-seen IDs", () => {
  const path = tempPath("merge");
  try {
    const store = new SeenStore(path);
    store.recordSeen("0xabc", { listingIds: ["l1"], saleIds: [] });
    store.recordSeen("0xabc", { listingIds: ["l2"], saleIds: ["s1"] });

    assert.deepEqual([...store.getListingIds("0xabc")].sort(), ["l1", "l2"]);
    assert.deepEqual([...store.getSaleIds("0xabc")], ["s1"]);
  } finally {
    rmSync(path, { force: true });
  }
});

test("SeenStore: forget drops a collection's persisted state entirely", () => {
  const path = tempPath("forget");
  try {
    const store = new SeenStore(path);
    store.recordSeen("0xabc", { listingIds: ["l1"], saleIds: [] });
    assert.equal(store.isNewCollection("0xabc"), false);

    store.forget("0xabc");
    assert.equal(store.isNewCollection("0xabc"), true);
  } finally {
    rmSync(path, { force: true });
  }
});

test("SeenStore: a missing/corrupt file is treated as empty state rather than throwing", () => {
  const path = tempPath("corrupt");
  try {
    // No file exists yet — reading should not throw.
    const store = new SeenStore(path);
    assert.equal(store.isNewCollection("0xabc"), true);
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(path, { force: true });
  }
});
