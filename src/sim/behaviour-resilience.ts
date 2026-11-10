/**
 * Resilience and delivery component behaviours: edgecompute, writebehind.
 *
 * Determinism notes, same rules as every other behaviour module:
 *   - timestamps are compared, never per-tick deltas accumulated;
 *   - RNG draws happen in a fixed position per event or not at all.
 */
import type { NodeStats } from './types';
import type { NodeStateLike } from './engine-types';
import type { AdmitAction, ComponentBehaviour } from './behaviour';
import { clamp01 } from './behaviour';

/* ================================================================== *
 * edgecompute -- limited compute at the CDN edge
 * ================================================================== */

/**
 * Compute at the edge: a small function running in the PoP itself.
 *
 * `edgeShare` is the fraction of requests it can fully answer -- an auth
 * check, a redirect, a personalised fragment assembled from what is already
 * at the edge. Those complete in single-digit milliseconds without a single
 * byte travelling to the origin. Everything else passes through and pays the
 * full origin path.
 *
 * The difference from the CDN is what the number means. A CDN's hitRate is a
 * property of the TRAFFIC (how repetitive it is); edgeShare is a property of
 * the CODE (how much logic you managed to push outward), and raising it is
 * engineering work, not luck. The lesson is the same shape though: the p50 a
 * client sees is a blend of two distributions, and moving work to the edge
 * moves requests between them one slider-notch at a time.
 *
 * What keeps it honest is the CPU BUDGET (`cpuMsCap`): an edge runtime is
 * not a server, and a request whose execution runs past the per-request
 * ceiling is killed at the edge and passed to the origin even though the
 * code could have answered it. Push heavier logic outward (raise serviceMs)
 * and the budget starts eating the very share you were trying to raise --
 * the trade every Workers/Lambda@Edge deployment lives with.
 *
 * One RNG draw per completion, unconditionally and in a fixed position, for
 * the same replay-stability reason the cache documents.
 */
const edgecompute: ComponentBehaviour = {
  kind: 'edgecompute',
  // An event-driven edge: the origin fetch is the caller's wait.
  blocksOnDownstream: false,
  servesRequests: true,
  instanceModel: 'slots',
  scaleField: 'instances',
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,

  onServiceComplete: (ctx, state, req) => {
    // One RNG draw, unconditionally and first, so the stream never depends
    // on the CPU budget check below.
    const canAnswer = ctx.roll() < clamp01(state.config.edgeShare ?? 0);
    if (canAnswer) {
      // The CPU budget: an edge runtime kills a request that runs past its
      // per-request ceiling, and the work falls through to the origin even
      // though the code COULD have answered it. Judged against the actual
      // execution time this request drew (req.ownMs), so a heavier function
      // body (higher serviceMs) blows the budget more often -- the exact
      // trade a student makes when pushing logic outward.
      const cap = state.config.cpuMsCap;
      if (cap !== undefined && cap > 0 && req.ownMs > cap) {
        ctx.countCustom(state, 'cpuExceeded', 1);
        ctx.countCustom(state, 'passedThrough', 1);
        return state.out.length === 0 ? 'complete' : 'downstream';
      }
      ctx.countCustom(state, 'edgeHandled', 1);
      return 'complete';
    }
    ctx.countCustom(state, 'passedThrough', 1);
    // Nothing behind it: it still answers, it just cannot demonstrate the
    // pass-through lesson.
    return state.out.length === 0 ? 'complete' : 'downstream';
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    stats.edgeHandledRate = ctx.counterRate(state, 'edgeHandled');
    stats.passedThroughRate = ctx.counterRate(state, 'passedThrough');
    stats.cpuExceededRate = ctx.counterRate(state, 'cpuExceeded');
  },
};

/* ================================================================== *
 * writebehind -- a write buffer that trades durability for latency
 * ================================================================== */

function cfgFlushDelayMs(state: NodeStateLike): number {
  const v = state.config.flushDelayMs;
  return v !== undefined && v > 0 ? v : 0;
}

/**
 * A write-behind cache: writes are acknowledged from memory in about a
 * millisecond, and flushed to the backing store `flushDelayMs` later.
 *
 * Chosen over a read-through variant deliberately: the existing `cache`
 * already IS read-through (hit answers, miss falls downstream), so the read
 * path is covered. What the palette lacked was the write path's bargain, and
 * write-behind is the sharpest form of it: the caller is told "saved" while
 * the data exists only in this node's memory.
 *
 * `capacity` is the buffer -- how many writes may sit dirty at once, memory
 * rather than threads -- and the standing dirty population is writeRate
 * times the flush delay, which the utilisation meter reads as buffer fill.
 *
 * The lesson has two halves. The visible half: downstream sees the same
 * write rate, just later and smoothed, and the caller's latency no longer
 * contains the store's -- that is why the pattern exists. The half that
 * matters: CRASH THIS NODE. Every buffered write fails as 'crashed' in the
 * same instant, and those are writes the callers were already told
 * succeeded. The failures spike on the graph is data loss made countable,
 * and no other component in the palette can show it.
 *
 * creditsJoinCompletion is FALSE for the same double-count reason as the
 * retry queue: the ack already booked the completion.
 */
const writebehind: ComponentBehaviour = {
  kind: 'writebehind',
  // The buffer slot covers the flush delay; the store write itself is
  // relayed, and the producer was acked at admission.
  blocksOnDownstream: false,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: false,
  observesOutcome: true,

  onAdmit: (ctx, state, req): AdmitAction => {
    if (ctx.queueDepth(state) >= ctx.effectiveQueueLimit(state)) return 'shed';
    // The relayed copy carries the flush delay as extra service time, so a
    // dirty write HOLDS its buffer slot for the whole residence interval --
    // which is what makes the buffer a real population a crash can lose,
    // not an accounting fiction.
    ctx.ackAndRelay(state, req, cfgFlushDelayMs(state));
    return 'handled';
  },

  onDownstreamResult: (ctx, state, _req, ok, _reason) => {
    ctx.countCustom(state, ok ? 'flushed' : 'flushFailed', 1);
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    // Dirty writes: acknowledged, not yet landed on the store. Buffered
    // (queued) plus mid-residence (inFlight); both die with the node.
    stats.dirtyWrites = stats.inFlight + stats.queued;
    stats.flushedRate = ctx.counterRate(state, 'flushed');
    // The 'flushFailed' counter was already booked in onDownstreamResult;
    // publish it. Every one of these is a write the caller believes is safe.
    stats.flushFailRate = ctx.counterRate(state, 'flushFailed');
  },
};

/** The behaviours defined in this module, for registration in behaviour.ts. */
export const RESILIENCE_BEHAVIOURS: ComponentBehaviour[] = [
  edgecompute,
  writebehind,
];
