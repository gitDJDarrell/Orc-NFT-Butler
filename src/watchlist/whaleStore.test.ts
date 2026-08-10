import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WhaleStore, isValidAddress } from "./whaleStore.js";

function tempStorePath(): string {
  return join(mkdtempSync(join(tmpdir(), "whale-store-")), "whales.json");
}

const WHALE_A = "0x1111111111111111111111111111111111111111";
const WHALE_B = "0x2222222222222222222222222222222222222222";

test("isValidAddress: accepts a 0x address and rejects malformed input", () => {
  assert.equal(isValidAddress(WHALE_A), true);
  assert.equal(isValidAddress("0x1234"), false);
  assert.equal(isValidAddress("not-an-address"), false);
  assert.equal(isValidAddress(""), false);
});

test("WhaleStore: add stores a wallet and rejects a malformed address", () => {
  const store = new WhaleStore(tempStorePath());

  const ok = store.add(WHALE_A, "punk whale");
  assert.equal(ok.ok, true);
  assert.equal(store.size, 1);

  const bad = store.add("0xnope", "typo");
  assert.equal(bad.ok, false);
  assert.match(bad.message, /not a valid/i);
  assert.equal(store.size, 1);
});

test("WhaleStore: rejects a duplicate regardless of case", () => {
  const store = new WhaleStore(tempStorePath());
  store.add(WHALE_A, "whale");

  const dup = store.add(WHALE_A.toUpperCase(), "same whale");
  assert.equal(dup.ok, false);
  assert.match(dup.message, /already tracked/i);
  assert.equal(store.size, 1);
});

test("WhaleStore: lookup is case-insensitive (OpenSea returns mixed-case addresses)", () => {
  const store = new WhaleStore(tempStorePath());
  store.add(WHALE_A, "whale");

  // This is the property the whole whale feature depends on: OpenSea sale
  // events carry checksummed (mixed-case) addresses, so a case-sensitive
  // lookup would silently never match.
  assert.ok(store.get("0X1111111111111111111111111111111111111111"));
  assert.ok(store.get(WHALE_A.toUpperCase()));
  assert.equal(store.get(WHALE_B), undefined);
  assert.equal(store.get(undefined), undefined);
});

test("WhaleStore: defaults the label to a shortened address", () => {
  const store = new WhaleStore(tempStorePath());
  store.add(WHALE_A);
  assert.equal(store.get(WHALE_A)?.label, "0x1111…1111");
});

test("WhaleStore: remove drops the wallet and reports an untracked one", () => {
  const store = new WhaleStore(tempStorePath());
  store.add(WHALE_A, "whale");

  assert.equal(store.remove(WHALE_A).ok, true);
  assert.equal(store.size, 0);

  const missing = store.remove(WHALE_B);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /isn't being tracked/i);
});

test("WhaleStore: persists across instances (survives a restart)", () => {
  const path = tempStorePath();
  const first = new WhaleStore(path);
  first.add(WHALE_A, "persistent whale");

  const reopened = new WhaleStore(path);
  assert.equal(reopened.size, 1);
  assert.equal(reopened.get(WHALE_A)?.label, "persistent whale");
});

test("WhaleStore: a corrupt file starts fresh rather than throwing", () => {
  const path = tempStorePath();
  writeFileSync(path, "{ not valid json", "utf8");

  const store = new WhaleStore(path);
  assert.equal(store.size, 0);
  assert.equal(store.add(WHALE_A, "recovered").ok, true);

  rmSync(path, { force: true });
});
