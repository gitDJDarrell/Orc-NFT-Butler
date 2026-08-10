import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WatchStore, type WatchedItem } from "./watchStore.js";

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "watch-store-")), "watched.json");
}

function makeItem(overrides: Partial<WatchedItem> = {}): WatchedItem {
  return {
    collectionId: "0xabc",
    collectionName: "Test Collection",
    tokenId: "1",
    lastKnownPriceNative: 0.5,
    lastKnownPriceCurrency: "ETH",
    addedAt: new Date("2026-08-10T00:00:00Z").toISOString(),
    missingTicks: 0,
    ...overrides,
  };
}

test("WatchStore: add then get round-trips an item", () => {
  const store = new WatchStore(tempStorePath());
  store.add(makeItem());

  const item = store.get("0xabc", "1");
  assert.equal(item?.collectionName, "Test Collection");
  assert.equal(item?.lastKnownPriceNative, 0.5);
});

test("WatchStore: survives a restart — the whole point of persisting it", () => {
  const path = tempStorePath();
  new WatchStore(path).add(makeItem({ tokenId: "42" }));

  const reopened = new WatchStore(path);
  assert.equal(reopened.get("0xabc", "42")?.tokenId, "42");
  assert.equal(reopened.getAll().length, 1);
});

test("WatchStore: remove reports whether anything was actually watched", () => {
  const store = new WatchStore(tempStorePath());
  store.add(makeItem());

  assert.equal(store.remove("0xabc", "1"), true);
  assert.equal(store.get("0xabc", "1"), undefined);
  assert.equal(store.remove("0xabc", "1"), false, "removing twice must report false");
  assert.equal(store.remove("0xnope", "9"), false);
});

test("WatchStore: update patches fields and is a no-op for an untracked token", () => {
  const store = new WatchStore(tempStorePath());
  store.add(makeItem());

  store.update("0xabc", "1", { lastKnownPriceNative: 0.35, missingTicks: 2 });
  const item = store.get("0xabc", "1");
  assert.equal(item?.lastKnownPriceNative, 0.35);
  assert.equal(item?.missingTicks, 2);
  assert.equal(item?.collectionName, "Test Collection", "unpatched fields must be preserved");

  store.update("0xabc", "does-not-exist", { missingTicks: 99 }); // must not throw or create anything
  assert.equal(store.getAll().length, 1);
});

test("WatchStore: different tokens and collections don't collide", () => {
  const store = new WatchStore(tempStorePath());
  store.add(makeItem({ tokenId: "1" }));
  store.add(makeItem({ tokenId: "2" }));
  store.add(makeItem({ collectionId: "0xdef", tokenId: "1" }));

  assert.equal(store.getForCollection("0xabc").length, 2);
  assert.equal(store.getForCollection("0xdef").length, 1);
  assert.equal(store.getAll().length, 3);
});

test("WatchStore: removing the last token drops the collection bucket", () => {
  const store = new WatchStore(tempStorePath());
  store.add(makeItem());
  store.remove("0xabc", "1");

  assert.deepEqual(store.getForCollection("0xabc"), []);
  assert.deepEqual(store.getAll(), []);
});

test("WatchStore: a corrupt file starts fresh rather than throwing", () => {
  const path = tempStorePath();
  writeFileSync(path, "{{{", "utf8");

  const store = new WatchStore(path);
  assert.deepEqual(store.getAll(), []);
  store.add(makeItem());
  assert.equal(store.getAll().length, 1);
});
