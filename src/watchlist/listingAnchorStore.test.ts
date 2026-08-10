import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ListingAnchorStore } from "./listingAnchorStore.js";

function tempPath(name: string): string {
  return join(tmpdir(), `listing-anchor-test-${name}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test("ListingAnchorStore: get returns undefined for an unknown token", () => {
  const path = tempPath("unknown");
  try {
    const store = new ListingAnchorStore(path);
    assert.equal(store.get("0xabc", "1"), undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

test("ListingAnchorStore: set then get round-trips", () => {
  const path = tempPath("roundtrip");
  try {
    const store = new ListingAnchorStore(path);
    store.set("0xabc", "1", { messageId: "m1", price: 0.5, priceCurrency: "ETH" });
    assert.deepEqual(store.get("0xabc", "1"), { messageId: "m1", price: 0.5, priceCurrency: "ETH" });
  } finally {
    rmSync(path, { force: true });
  }
});

test("ListingAnchorStore: persists across instances (restart simulation)", () => {
  const path = tempPath("restart");
  try {
    const first = new ListingAnchorStore(path);
    first.set("0xabc", "1", { messageId: "m1", price: 0.5, priceCurrency: "ETH" });

    const second = new ListingAnchorStore(path);
    assert.deepEqual(second.get("0xabc", "1"), { messageId: "m1", price: 0.5, priceCurrency: "ETH" });
  } finally {
    rmSync(path, { force: true });
  }
});

test("ListingAnchorStore: set replaces the prior anchor for that token", () => {
  const path = tempPath("replace");
  try {
    const store = new ListingAnchorStore(path);
    store.set("0xabc", "1", { messageId: "m1", threadId: "t1", price: 0.5, priceCurrency: "ETH" });
    store.set("0xabc", "1", { messageId: "m2", price: 0.6, priceCurrency: "ETH" });
    assert.deepEqual(store.get("0xabc", "1"), { messageId: "m2", price: 0.6, priceCurrency: "ETH" });
  } finally {
    rmSync(path, { force: true });
  }
});

test("ListingAnchorStore: updateRecurrence patches thread/status-message/seen-count, leaving price intact", () => {
  const path = tempPath("update-recurrence");
  try {
    const store = new ListingAnchorStore(path);
    store.set("0xabc", "1", { messageId: "m1", price: 0.5, priceCurrency: "ETH" });
    store.updateRecurrence("0xabc", "1", { threadId: "thread-1", statusMessageId: "status-1", seenCount: 2 });
    assert.deepEqual(store.get("0xabc", "1"), {
      messageId: "m1",
      threadId: "thread-1",
      statusMessageId: "status-1",
      seenCount: 2,
      price: 0.5,
      priceCurrency: "ETH",
    });
  } finally {
    rmSync(path, { force: true });
  }
});

test("ListingAnchorStore: updateRecurrence on subsequent calls overwrites the prior status message id/seen count", () => {
  const path = tempPath("update-recurrence-twice");
  try {
    const store = new ListingAnchorStore(path);
    store.set("0xabc", "1", { messageId: "m1", price: 0.5, priceCurrency: "ETH" });
    store.updateRecurrence("0xabc", "1", { threadId: "thread-1", statusMessageId: "status-1", seenCount: 2 });
    store.updateRecurrence("0xabc", "1", { threadId: "thread-1", statusMessageId: "status-1", seenCount: 3 });
    assert.equal(store.get("0xabc", "1")?.seenCount, 3);
    assert.equal(store.get("0xabc", "1")?.statusMessageId, "status-1");
  } finally {
    rmSync(path, { force: true });
  }
});

test("ListingAnchorStore: updateRecurrence on an unknown token is a no-op", () => {
  const path = tempPath("update-recurrence-unknown");
  try {
    const store = new ListingAnchorStore(path);
    store.updateRecurrence("0xabc", "1", { threadId: "thread-1", statusMessageId: "status-1", seenCount: 2 });
    assert.equal(store.get("0xabc", "1"), undefined);
  } finally {
    rmSync(path, { force: true });
  }
});

test("ListingAnchorStore: different tokens in the same collection don't collide", () => {
  const path = tempPath("multi-token");
  try {
    const store = new ListingAnchorStore(path);
    store.set("0xabc", "1", { messageId: "m1", price: 0.5, priceCurrency: "ETH" });
    store.set("0xabc", "2", { messageId: "m2", price: 0.7, priceCurrency: "ETH" });
    assert.equal(store.get("0xabc", "1")?.messageId, "m1");
    assert.equal(store.get("0xabc", "2")?.messageId, "m2");
  } finally {
    rmSync(path, { force: true });
  }
});
