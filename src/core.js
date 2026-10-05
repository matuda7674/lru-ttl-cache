/**
 * LruTtlCache — a bounded cache that evicts entries on two grounds:
 *   1. Time-to-live expiry (an entry is stale once `now - insertedAt >= ttl`).
 *   2. Least-recently-used eviction when capacity is exceeded.
 *
 * The expiry check is lazy: we do not run a timer in the background. Stale
 * entries are removed when they are touched (get/has) or when capacity pressure
 * forces a sweep. This keeps the implementation dependency-free and, more
 * importantly, deterministic — no hidden timers that fire outside the control
 * of the caller. That makes the cache testable without sleeping on wall-clock
 * time.
 *
 * The access order is maintained with a doubly-linked list so that LRU
 * move-to-front is O(1). The map gives O(1) lookup by key. TTL is checked
 * on read; a stale read returns undefined and evicts the node, which keeps
 * the hot path cheap and avoids sweeping the entire cache on every get.
 */

class Node {
  /**
   * @param {string} key
   * @param {*} value
   * @param {number} insertedAt   epoch-ish milliseconds, taken from the clock
   */
  constructor(key, value, insertedAt) {
    this.key = key;
    this.value = value;
    this.insertedAt = insertedAt;
    this.prev = null;
    this.next = null;
  }
}

class LruTtlCache {
  /**
   * @param {object} opts
   * @param {number} opts.capacity      Maximum live entries. Must be >= 1.
   * @param {number} opts.ttl           Time-to-live in milliseconds. Must be > 0.
   * @param {() => number} [opts.clock] Returns current time in ms. Default
   *                                   `Date.now`. Inject a fake in tests.
   */
  constructor({ capacity, ttl, clock = () => Date.now() }) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
      throw new RangeError(`ttl must be a positive finite number, got ${ttl}`);
    }
    if (typeof clock !== 'function') {
      throw new TypeError('clock must be a function returning a number');
    }

    this.capacity = capacity;
    this.ttl = ttl;
    this.clock = clock;
    this.map = new Map();
    // Sentinel nodes simplify the linked-list bookkeeping: every real node
    // always sits between two other nodes, so there are no null-check
    // special cases in insert/remove.
    this.head = new Node(null, null, 0); // most-recently-used end
    this.tail = new Node(null, null, 0); // least-recently-used end
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Remove a node from the linked list. Does not touch the map.
   * @param {Node} node
   * @private
   */
  _unlink(node) {
    node.prev.next = node.next;
    node.next.prev = node.prev;
    node.prev = null;
    node.next = null;
  }

  /**
   * Insert a node at the MRU end (right after the head sentinel).
   * @param {Node} node
   * @private
   */
  _prepend(node) {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next.prev = node;
    this.head.next = node;
  }

  /**
   * Move an existing node to the MRU end.
   * @param {Node} node
   * @private
   */
  _touch(node) {
    this._unlink(node);
    this._prepend(node);
  }

  /**
   * @param {string} key
   * @returns {boolean} true if the entry exists and is not stale.
   */
  has(key) {
    const node = this.map.get(key);
    if (node === undefined) return false;
    if (this.clock() - node.insertedAt >= this.ttl) {
      this._deleteNode(node);
      return false;
    }
    return true;
  }

  /**
   * @param {string} key
   * @returns {*} the value, or undefined if missing or stale.
   */
  get(key) {
    const node = this.map.get(key);
    if (node === undefined) return undefined;
    if (this.clock() - node.insertedAt >= this.ttl) {
      this._deleteNode(node);
      return undefined;
    }
    this._touch(node);
    return node.value;
  }

  /**
   * Insert or update a value. Re-inserting a key refreshes its TTL (the
   * insertion timestamp is updated to now) and moves it to the MRU end.
   *
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    const existing = this.map.get(key);
    const now = this.clock();
    if (existing !== undefined) {
      existing.value = value;
      existing.insertedAt = now;
      this._touch(existing);
      return;
    }

    const node = new Node(key, value, now);
    this.map.set(key, node);
    this._prepend(node);

    if (this.map.size > this.capacity) {
      this._evictLru();
    }
  }

  /**
   * Remove the least-recently-used node. The LRU node is the one right before
   * the tail sentinel. We do not TTL-check here: if it were stale we would
   * still want it gone to make room, so the distinction is irrelevant for
   * capacity eviction.
   * @private
   */
  _evictLru() {
    const lru = this.tail.prev;
    if (lru === this.head) return; // empty
    this._deleteNode(lru);
  }

  /**
   * Delete a node from both the list and the map.
   * @param {Node} node
   * @private
   */
  _deleteNode(node) {
    this._unlink(node);
    this.map.delete(node.key);
  }

  /**
   * @param {string} key
   */
  delete(key) {
    const node = this.map.get(key);
    if (node === undefined) return;
    this._deleteNode(node);
  }

  /**
   * Remove every entry.
   */
  clear() {
    this.map.clear();
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  /**
   * Number of entries currently in the cache. This is the raw count; some of
   * those entries may be stale but not yet swept (stale entries are removed
   * lazily on touch or on capacity pressure).
   *
   * @returns {number}
   */
  get size() {
    return this.map.size;
  }

  /**
   * Walk the cache from most to least recently used and drop every stale
   * entry. Returns the count removed. Useful when the caller wants a
   * deterministic point-in-time sweep — e.g. between requests.
   *
   * @returns {number}
   */
  sweepExpired() {
    const now = this.clock();
    let removed = 0;
    // Iterate over a snapshot of keys so deletion during iteration is safe.
    for (const key of Array.from(this.map.keys())) {
      const node = this.map.get(key);
      if (node !== undefined && now - node.insertedAt >= this.ttl) {
        this._deleteNode(node);
        removed += 1;
      }
    }
    return removed;
  }
}

export { LruTtlCache };
