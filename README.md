# LRU TTL Cache

A small, zero-dependency, dependency-free in-memory cache for JavaScript that evicts entries on two grounds: when they exceed a time-to-live, and when the cache is over capacity by evicting the least-recently-used entry.

## Usage

```js
import { LruTtlCache } from 'lru-ttl-cache';

const cache = new LruTtlCache({ capacity: 100, ttl: 60_000 });

cache.set('user:42', { name: 'Ada' });
cache.get('user:42'); // -> { name: 'Ada' }
cache.has('user:42'); // -> true
cache.delete('user:42');
cache.clear();
cache.sweepExpired(); // -> number removed
```

Exports exactly one name: `LruTtlCache`.

Constructor options:

- `capacity` (required, positive integer) — maximum live entries.
- `ttl` (required, positive finite number) — milliseconds an entry lives.
- `clock` (optional, `() => number`) — returns current time in ms. Defaults to `Date.now`. Inject a fake clock in tests.

Methods: `get`, `set`, `has`, `delete`, `clear`, `sweepExpired`. The `size` getter returns the current entry count.

## Why this exists

The problem: a bounded cache whose entries also go stale on a timer. Pure LRU caches keep stale data forever; pure TTL caches can grow unbounded. This library does both in O(1) per operation using a `Map` for lookup and a doubly-linked list for access order.

The trade-off: expiry is lazy. There is no background timer sweeping stale entries — they are removed when touched (`get`/`has`) or when capacity pressure forces an eviction. This keeps the implementation dependency-free and deterministic, which matters most for tests. If you need guaranteed expiry at a wall-clock deadline, call `sweepExpired()` at a point you control, or run your own timer around it.

## The awkward edge

`size` is the raw count of nodes, including entries that are stale but not yet swept. A stale entry still occupies a slot against `capacity` until it is touched or swept. If you need an exact live count, call `sweepExpired()` first. Re-inserting a key refreshes its TTL and moves it to the most-recently-used end — this is deliberate, since a `set` is normally a signal the value is fresh again.

TTL is inclusive: an entry is stale once `now - insertedAt >= ttl`, so an entry set at time 0 with ttl 50 is expired at time 50, not 51.
