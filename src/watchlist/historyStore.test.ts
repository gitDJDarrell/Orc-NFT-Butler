import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FloorHistoryStore } from "./historyStore.js";

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "history-store-")), "history.json");
}

const COLLECTION = "0xAbC0000000000000000000000000000000000001";

test("FloorHistoryStore: records and reads back samples in order", () => {
  const store = new FloorHistoryStore(tempStorePath());
  store.record(COLLECTION, { t: "2026-08-10T00:00:00Z", floor: 0.4, volume: 10 });
  store.record(COLLECTION, { t: "2026-08-10T01:00:00Z", floor: 0.45 });

  const all = store.getAll(COLLECTION);
  assert.equal(all.length, 2);
  assert.equal(all[0]!.floor, 0.4);
  assert.equal(all[1]!.floor, 0.45);
});

test("FloorHistoryStore: keys are case-insensitive", () => {
  const store = new FloorHistoryStore(tempStorePath());
  store.record(COLLECTION, { t: "2026-08-10T00:00:00Z", floor: 0.4 });
  assert.equal(store.getAll(COLLECTION.toLowerCase()).length, 1);
  assert.equal(store.getAll(COLLECTION.toUpperCase()).length, 1);
});

test("FloorHistoryStore: getSince filters to the trailing window", () => {
  const store = new FloorHistoryStore(tempStorePath());
  const now = Date.now();
  store.record(COLLECTION, { t: new Date(now - 48 * 3_600_000).toISOString(), floor: 0.1 }); // 48h ago
  store.record(COLLECTION, { t: new Date(now - 2 * 3_600_000).toISOString(), floor: 0.2 }); // 2h ago

  const recent = store.getSince(COLLECTION, 24);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.floor, 0.2);
});

test("FloorHistoryStore: getSince drops samples with an unparseable timestamp", () => {
  const store = new FloorHistoryStore(tempStorePath());
  store.record(COLLECTION, { t: "not-a-date", floor: 0.9 });
  store.record(COLLECTION, { t: new Date().toISOString(), floor: 0.2 });

  const recent = store.getSince(COLLECTION, 24);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]!.floor, 0.2);
});

test("FloorHistoryStore: trims to the retention cap, keeping the newest", () => {
  const store = new FloorHistoryStore(tempStorePath());
  for (let i = 0; i < 750; i++) {
    store.record(COLLECTION, { t: new Date(Date.parse("2026-01-01T00:00:00Z") + i * 3_600_000).toISOString(), floor: i });
  }

  const all = store.getAll(COLLECTION);
  assert.equal(all.length, 720);
  assert.equal(all[all.length - 1]!.floor, 749, "the newest sample must be retained");
  assert.equal(all[0]!.floor, 30, "the oldest 30 should have aged out");
});

test("FloorHistoryStore: persists across instances", () => {
  const path = tempStorePath();
  new FloorHistoryStore(path).record(COLLECTION, { t: "2026-08-10T00:00:00Z", floor: 0.4 });

  assert.equal(new FloorHistoryStore(path).getAll(COLLECTION).length, 1);
});

test("FloorHistoryStore: forget drops one collection's series", () => {
  const store = new FloorHistoryStore(tempStorePath());
  store.record(COLLECTION, { t: "2026-08-10T00:00:00Z", floor: 0.4 });
  store.record("0xother", { t: "2026-08-10T00:00:00Z", floor: 1 });

  store.forget(COLLECTION);
  assert.equal(store.getAll(COLLECTION).length, 0);
  assert.equal(store.getAll("0xother").length, 1);
});

test("FloorHistoryStore: a corrupt file starts fresh rather than throwing", () => {
  const path = tempStorePath();
  writeFileSync(path, "definitely not json", "utf8");

  const store = new FloorHistoryStore(path);
  assert.deepEqual(store.getAll(COLLECTION), []);
});

test("FloorHistoryStore: a non-array entry is discarded instead of crashing later", () => {
  const path = tempStorePath();
  writeFileSync(path, JSON.stringify({ "0xbad": { not: "an array" }, "0xgood": [{ t: "2026-08-10T00:00:00Z", floor: 1 }] }), "utf8");

  const store = new FloorHistoryStore(path);
  assert.deepEqual(store.getAll("0xbad"), []);
  assert.equal(store.getAll("0xgood").length, 1);
});
