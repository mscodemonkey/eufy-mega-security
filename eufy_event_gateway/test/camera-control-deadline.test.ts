/**
 * Verifies operation cancellation with injected time and test-owned resources.
 * These tests never open sockets; the provider consumes the same scope for its
 * queue, command dispatch and independent confirmation phases.
 */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { CameraControlDeadlineError, withCameraControlDeadline, type CameraControlScope } from "../src/provider/camera-control-deadline.js";

/** Own one deadline callback without a real timer or a wall-clock wait. */
function clock() {
  let expire!: () => void;
  let cleared = false;
  return { milliseconds: 90_000, schedule: (callback: () => void) => {
    expire = callback; return () => { cleared = true; };
  }, expire: () => expire(), cleared: () => cleared };
}

for (const dispatched of [false, true]) {
  test(`expiry closes resources before caller rejection, dispatched=${dispatched}`, async () => {
    const timer = clock();
    let closed = false;
    let rejectLate!: (error: Error) => void;
    let scope!: CameraControlScope;
    const pending = withCameraControlDeadline(async owner => {
      scope = owner;
      owner.onAbort(() => { closed = true; });
      if (dispatched) owner.dispatched();
      await owner.wait(() => new Promise<void>((_resolve, reject) => { rejectLate = reject; }));
      throw Error("retired work resumed");
    }, undefined, timer);
    const checked = assert.rejects(pending, error => {
      assert.equal(closed, true);
      assert.ok(error instanceof CameraControlDeadlineError);
      assert.equal(error.code, dispatched ? "outcome_unknown" : "not_started");
      return true;
    });
    await new Promise(resolve => setImmediate(resolve));
    timer.expire(); await checked;
    rejectLate(Error("late private marker"));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(timer.cleared(), true);
    assert.equal(getEventListeners(scope.signal, "abort").length, 0);
    let invoked = false;
    await assert.rejects(scope.wait(async () => { invoked = true; }), CameraControlDeadlineError);
    assert.equal(invoked, false);
  });
}

test("pre-abort never invokes the operation and removes parent listeners", async () => {
  const parent = new AbortController(); parent.abort();
  const timer = clock(); let invoked = false;
  await assert.rejects(withCameraControlDeadline(async () => { invoked = true; }, parent.signal, timer), CameraControlDeadlineError);
  assert.equal(invoked, false);
  assert.equal(getEventListeners(parent.signal, "abort").length, 0);
  assert.equal(timer.cleared(), true);
});

test("synchronous phase failures release listeners and the original error", async () => {
  const timer = clock();
  let scope!: CameraControlScope;
  await assert.rejects(withCameraControlDeadline(async owner => {
    scope = owner;
    await owner.wait(() => { throw Error("hard failure"); });
  }, undefined, timer), /hard failure/);
  assert.equal(getEventListeners(scope.signal, "abort").length, 0);
  assert.equal(timer.cleared(), true);
});
