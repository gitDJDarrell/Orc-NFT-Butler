import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestScheduler } from "./requestScheduler.js";

test("RequestScheduler: dispatches immediately when under budget", async () => {
  const scheduler = new RequestScheduler(10, 200);
  const result = await scheduler.schedule("key-a", async () => 42);
  assert.equal(result, 42);
});

test("RequestScheduler: coalesces concurrent calls sharing the same key into a single dispatch", async () => {
  const scheduler = new RequestScheduler(10, 200);
  let callCount = 0;
  const fn = async () => {
    callCount += 1;
    return "shared-result";
  };

  const [a, b, c] = await Promise.all([scheduler.schedule("same-url", fn), scheduler.schedule("same-url", fn), scheduler.schedule("same-url", fn)]);

  assert.equal(callCount, 1);
  assert.equal(a, "shared-result");
  assert.equal(b, "shared-result");
  assert.equal(c, "shared-result");
});

test("RequestScheduler: different keys do NOT get coalesced", async () => {
  const scheduler = new RequestScheduler(10, 200);
  let callCount = 0;
  const fn = async () => {
    callCount += 1;
    return callCount;
  };

  const [a, b] = await Promise.all([scheduler.schedule("url-1", fn), scheduler.schedule("url-2", fn)]);
  assert.equal(callCount, 2);
  assert.notEqual(a, b);
});

test("RequestScheduler: queues requests over budget and dispatches the rest once the window rolls over", async () => {
  // Budget of 2 per a 150ms window - fire 3 distinct requests immediately;
  // the 3rd must wait for the window to roll over before dispatching.
  const scheduler = new RequestScheduler(2, 150);
  const dispatchOrder: number[] = [];
  const makeTask = (id: number) => async () => {
    dispatchOrder.push(id);
    return id;
  };

  const results = await Promise.all([
    scheduler.schedule("a", makeTask(1)),
    scheduler.schedule("b", makeTask(2)),
    scheduler.schedule("c", makeTask(3)),
  ]);

  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(dispatchOrder, [1, 2, 3]); // FIFO
});

test("RequestScheduler: getHealth reports budget, queue depth, and recent 429s", async () => {
  const scheduler = new RequestScheduler(5, 500);
  await scheduler.schedule("x", async () => "ok");

  const healthAfterSuccess = scheduler.getHealth();
  assert.equal(healthAfterSuccess.budgetPerMinute, 5);
  assert.equal(healthAfterSuccess.requestsInLastMinute, 1);
  assert.equal(healthAfterSuccess.recent429Count, 0);
  assert.equal(healthAfterSuccess.last429At, undefined);

  scheduler.recordRateLimited(1); // 1 second retry-after
  const healthAfter429 = scheduler.getHealth();
  assert.equal(healthAfter429.recent429Count, 1);
  assert.notEqual(healthAfter429.last429At, undefined);
  assert.notEqual(healthAfter429.pausedUntil, undefined);
});

test("RequestScheduler: recordRateLimited pauses dispatch of already-queued work until the backoff elapses", async () => {
  const scheduler = new RequestScheduler(10, 500);
  scheduler.recordRateLimited(0.15); // 150ms backoff

  const start = Date.now();
  await scheduler.schedule("after-429", async () => "done");
  const elapsed = Date.now() - start;

  assert.ok(elapsed >= 100, `expected dispatch to wait out the backoff, only waited ${elapsed}ms`);
});
