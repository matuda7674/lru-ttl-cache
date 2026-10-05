import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruTtlCache } from '../src/index.js';

// A controllable clock so no test ever touches wall-clock time.
function makeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
    set: (ms) => { t = ms; return t; },
  };
}

test('constructor validates capacity', () => {
  assert.throws(() => new LruTtlCache({ capacity: 0, ttl: 100 }), RangeError);
  assert.throws(() => new LruTtlCache({ capacity: 1.5, ttl: 100 }), RangeError);
  assert.throws(() => new LruTtlCache({ capacity: -1, ttl: 100 }), RangeError);
});

test('constructor validates ttl', () => {
  assert.throws(() => new LruTtlCache({ capacity: 5, ttl: 0 }), RangeError);
  assert.throws(() => new LruTtlCache({ capacity: 5, ttl: -1 }), RangeError);
  assert.throws(() => new LruTtlCache({ capacity: 5, ttl: Infinity }), RangeError);
  assert.throws(() => new LruTtlCache({ capacity: 5, ttl: NaN }), RangeError);
});

test('constructor rejects a non-function clock', () => {
  assert.throws(() => new LruTtlCache({ capacity: 2, ttl: 10, clock: 'now' }), TypeError);
});

test('set and get a value within ttl', () => {
  const c = new LruTtlCache({ capacity: 3, ttl: 100 });
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  assert.equal(c.size, 1);
});

test('get returns undefined for missing key', () => {
  const c = new LruTtlCache({ capacity: 3, ttl: 100 });
  assert.equal(c.get('missing'), undefined);
});

test('has reflects presence and staleness', () => {
  const clock = makeClock(0);
  const c = new LruTtlCache({ capacity: 3, ttl: 50, clock: clock.now });
  c.set('a', 1);
  assert.equal(c.has('a'), true);
  clock.advance(50);
  assert.equal(c.has('a'), false);
  assert.equal(c.size, 0);
});

test('get on a stale entry evicts it and returns undefined', () => {
  const clock = makeClock(0);
  const c = new LruTtlCache({ capacity: 3, ttl: 50, clock: clock.now });
  c.set('a', 1);
  clock.advance(50);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.size, 0);
});

test('re-set refreshes ttl and moves to mru', () => {
  const clock = makeClock(0);
  const c = new LruTtlCache({ capacity: 2, ttl: 100, clock: clock.now });
  c.set('a', 1);
  clock.advance(90);
  c.set('a', 2); // refresh: ttl window should restart from 90
  clock.advance(90); // now at 180, 90 since refresh
  assert.equal(c.get('a'), 2); // not stale
  assert.equal(c.size, 1);
});

test('LRU eviction drops the least recently used', () => {
  const c = new LruTtlCache({ capacity: 2, ttl: 1000 });
  c.set('a', 1);
  c.set('b', 2);
  // touch 'a' so 'b' is LRU
  assert.equal(c.get('a'), 1);
  c.set('c', 3); // capacity exceeded, evict 'b'
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
});

test('LRU eviction happens on set that exceeds capacity by one', () => {
  const c = new LruTtlCache({ capacity: 3, ttl: 1000 });
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.set('d', 4); // evicts 'a' (oldest, untouched)
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.get('c'), 3);
  assert.equal(c.get('d'), 4);
  assert.equal(c.size, 3);
});

test('delete removes an entry', () => {
  const c = new LruTtlCache({ capacity: 3, ttl: 1000 });
  c.set('a', 1);
  c.delete('a');
  assert.equal(c.get('a'), undefined);
  assert.equal(c.size, 0);
});

test('delete on missing key is a no-op', () => {
  const c = new LruTtlCache({ capacity: 3, ttl: 1000 });
  assert.doesNotThrow(() => c.delete('nope'));
  assert.equal(c.size, 0);
});

test('clear empties the cache', () => {
  const c = new LruTtlCache({ capacity: 3, ttl: 1000 });
  c.set('a', 1);
  c.set('b', 2);
  c.clear();
  assert.equal(c.size, 0);
  assert.equal(c.get('a'), undefined);
});

test('after clear, the cache behaves normally', () => {
  const c = new LruTtlCache({ capacity: 2, ttl: 1000 });
  c.set('a', 1);
  c.clear();
  c.set('b', 2);
  assert.equal(c.get('b'), 2);
  assert.equal(c.size, 1);
});

test('sweepExpired removes only stale entries and returns the count', () => {
  const clock = makeClock(0);
  const c = new LruTtlCache({ capacity: 10, ttl: 50, clock: clock.now });
  c.set('a', 1);
  clock.advance(25);
  c.set('b', 2);
  clock.advance(25); // 'a' is now stale (50ms), 'b' is not (25ms)
  const removed = c.sweepExpired();
  assert.equal(removed, 1);
  assert.equal(c.has('a'), false);
  assert.equal(c.has('b'), true);
});

test('sweepExpired on a clean cache removes nothing', () => {
  const clock = makeClock(0);
  const c = new LruTtlCache({ capacity: 3, ttl: 50, clock: clock.now });
  c.set('a', 1);
  assert.equal(c.sweepExpired(), 0);
});

test('exact ttl boundary counts as expired', () => {
  const clock = makeClock(0);
  const c = new LruTtlCache({ capacity: 3, ttl: 50, clock: clock.now });
  c.set('a', 1);
  clock.set(50); // exactly ttl elapsed
  assert.equal(c.has('a'), false);
});

test('capacity 1 holds only the latest', () => {
  const c = new LruTtlCache({ capacity: 1, ttl: 1000 });
  c.set('a', 1);
  assert.equal(c.get('a'), 1);
  c.set('b', 2);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.size, 1);
});

test('overwriting a key does not increase size', () => {
  const c = new LruTtlCache({ capacity: 2, ttl: 1000 });
  c.set('a', 1);
  c.set('a', 2);
  assert.equal(c.size, 1);
  assert.equal(c.get('a'), 2);
});

test('stale entry on get does not affect other entries', () => {
  const clock = makeClock(0);
  const c = new LruTtlCache({ capacity: 3, ttl: 50, clock: clock.now });
  c.set('a', 1);
  clock.advance(25);
  c.set('b', 2);
  clock.advance(25); // 'a' stale, 'b' fresh
  assert.equal(c.get('a'), undefined);
  assert.equal(c.get('b'), 2);
  assert.equal(c.size, 1);
});
