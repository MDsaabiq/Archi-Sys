/**
 * Edge-protection component behaviours: cdn, ratelimiter, breaker.
 *
 * These three are the layer that sits in FRONT of a system and decides what
 * ever reaches it. Grouped in their own module because they share a theme a
 * student can name -- "how do I stop load before it hurts me" -- and because
 * keeping them out of behaviour.ts keeps that file readable as the kind count
 * grows.
 *
 * Every one of them is a plain ComponentBehaviour: the event loop has no idea
 * they exist. None of them added a conditional to engine.ts.
 *
 * A note on determinism, which constrains all three. `advance(dt)` is driven
 * by wall-clock frames, so dt varies from frame to frame. Anything that
 * decides "has enough time passed?" therefore has to compare *simulated
 * timestamps*, never accumulate per-tick deltas -- otherwise the same seed
 * produces different results at a different frame rate. That is why the token
 * bucket refills against `now - lastRefillMs` and the breaker's state
 * transitions are evaluated lazily when a request arrives, rather than from
 * onTick.
 */
import type { NodeStats } from './types';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import type { ComponentBehaviour } from './behaviour';
import { clamp01 } from './behaviour';

/* ------------------------------------------------------------------ *
 * cdn
 * ------------------------------------------------------------------ */

/**
 * A content delivery network edge cache.
 *
 * Mechanically this is a cache that sits geographically in front of
 * everything: `serviceMs` is tiny (you are talking to a nearby PoP, not the
 * origin) and `hitRate` is high. The teaching point is entirely in what the
 * numbers do to the rest of the topology -- at hitRate 0.9 the origin sees a
 * tenth of the offered load, so the CDN is doing 90% of the work of ten extra
 * servers for none of the cost.
 *
 * The one behavioural difference from `cache`: a miss here is expensive,
 * because the origin is far away. That falls out naturally rather than being
 * special-cased -- the miss goes downstream and pays whatever the origin path
 * costs, including any edge latency wired onto the link.
 */
const cdn: ComponentBehaviour = {
  kind: 'cdn',
  // An event-driven edge: the origin fetch is the caller's wait.
  blocksOnDownstream: false,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,

  onServiceComplete: (ctx, state, _req) => {
    // One RNG draw, unconditionally, in a fixed position. Drawing only on
    // some paths would make the stream depend on config and break replay.
    if (ctx.roll() < clamp01(state.config.hitRate)) {
      ctx.countHit(state);
      return 'complete';
    }
    ctx.countMiss(state);
    // A miss must be fetched from origin. Book it separately from the generic
    // miss counter so the UI can show origin load in requests/sec -- "what
    // actually reached your servers" is the number worth teaching.
    ctx.countCustom(state, 'originFetch', 1);
    // Nothing behind the CDN: it still answers, it just cannot demonstrate
    // the origin-offload lesson.
    return state.out.length === 0 ? 'complete' : 'downstream';
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    stats.originFetchRate = ctx.counterRate(state, 'originFetch');
  },
};

/* ------------------------------------------------------------------ *
 * ratelimiter
 * ------------------------------------------------------------------ */

/** Token bucket state. */
interface BucketState {
  /** Tokens available right now. Fractional: refill is continuous. */
  tokens: number;
  /** Simulated time the bucket was last refilled, in ms. */
  lastRefillMs: number;
  /** Bucket size the tokens were last capped against, to detect a config change. */
  lastBurst: number;
}

/** `rateLimitRps`, defaulted and floored to something sane. */
function limitRate(state: NodeStateLike): number {
  const r = state.config.rateLimitRps;
  return r !== undefined && r > 0 ? r : 0;
}

/** Bucket size in tokens. Defaults to one second's worth of rate. */
function limitBurst(state: NodeStateLike): number {
  const b = state.config.burst;
  if (b !== undefined && b > 0) return b;
  const r = limitRate(state);
  return r > 0 ? r : 1;
}

/**
 * Bring the bucket up to date with the current simulated time.
 *
 * Refill is computed from elapsed simulated ms, NOT accumulated per tick.
 * This is what makes the limiter exact: over T seconds it grants exactly
 * rate*T tokens regardless of how many advance() calls that T was split
 * across, so a 16ms frame and a 100ms frame produce identical admissions.
 * A per-tick `tokens += rate * dt` would drift with frame rate and, worse,
 * would make the sim non-deterministic against a variable frame clock.
 */
function refill(ctx: BehaviourCtx, state: NodeStateLike, b: BucketState): void {
  const burst = limitBurst(state);

  // The student moved the burst slider. Re-cap rather than letting a bucket
  // filled under the old ceiling stay oversized forever.
  if (burst !== b.lastBurst) {
    if (b.tokens > burst) b.tokens = burst;
    b.lastBurst = burst;
  }

  const elapsed = ctx.now - b.lastRefillMs;
  if (elapsed <= 0) return;
  b.lastRefillMs = ctx.now;

  const rate = limitRate(state);
  if (rate <= 0) return;

  b.tokens += (elapsed / 1000) * rate;
  if (b.tokens > burst) b.tokens = burst;
}

/**
 * The bucket level as of `ctx.now`, WITHOUT mutating it.
 *
 * Same arithmetic as refill(), used for reporting only. Kept separate so
 * there is no way for a snapshot to accidentally advance the bucket: the
 * engine may be snapshotted many times between two arrivals, and each of
 * those must be a pure read.
 */
function projectedTokens(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  b: BucketState,
): number {
  const burst = limitBurst(state);
  let tokens = b.tokens > burst ? burst : b.tokens;
  const rate = limitRate(state);
  const elapsed = ctx.now - b.lastRefillMs;
  if (rate > 0 && elapsed > 0) {
    tokens += (elapsed / 1000) * rate;
    if (tokens > burst) tokens = burst;
  }
  return tokens;
}

/**
 * A token bucket in front of whatever it fronts.
 *
 * Every request costs one token. A request that finds the bucket empty is
 * refused immediately as 'throttled' -- it never queues, never occupies a
 * slot, and never touches downstream. That cheapness is the whole point: the
 * lesson is that refusing 400 rps at the door costs almost nothing, whereas
 * accepting them and letting them queue is what actually takes the system
 * down. A student can watch the same offered load produce a healthy service
 * with a limiter and a collapsed one without.
 *
 * Zero RNG draws, so a limiter never perturbs the random stream.
 */
const ratelimiter: ComponentBehaviour = {
  kind: 'ratelimiter',
  // A gate with no slots: it decides and hands the request on.
  blocksOnDownstream: false,
  // A limiter is a doorman, not a server: it holds no slots and its
  // utilisation would be meaningless, so it reports none.
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,

  initState: (state): BucketState => ({
    // A fresh limiter starts FULL, so an idle system absorbs one full burst
    // instantly -- which is exactly the behaviour a token bucket is chosen
    // for, and the first thing worth demonstrating.
    tokens: limitBurst(state),
    lastRefillMs: 0,
    lastBurst: limitBurst(state),
  }),

  onAdmit: (ctx, state, req) => {
    const b = state.ext as BucketState;
    refill(ctx, state, b);

    // rate <= 0 means "no limit configured": pass everything rather than
    // silently black-holing the topology a student just wired up.
    if (limitRate(state) <= 0) {
      ctx.countCustom(state, 'admitted', 1);
      return 'passthru';
    }

    if (b.tokens >= 1) {
      b.tokens -= 1;
      ctx.countCustom(state, 'admitted', 1);
      return 'passthru';
    }

    ctx.countCustom(state, 'throttled', 1);
    ctx.reject(state, req, 'throttled');
    return 'handled';
  },

  decorateStats: (ctx, state, stats: NodeStats) => {
    const b = state.ext as BucketState | null;
    stats.admittedRate = ctx.counterRate(state, 'admitted');
    stats.throttledRate = ctx.counterRate(state, 'throttled');
    // Report the bucket as of NOW, not as of the last arrival. Refill is
    // lazy -- b.tokens is only brought up to date when a request turns up --
    // so reading the stored value straight out would show an idle limiter's
    // bucket frozen instead of visibly filling, and would misreport by up to
    // rate*(now - lastRefill) whenever traffic is sparse. Computed here
    // rather than by calling refill(), because snapshot() must not mutate
    // simulation state: taking a snapshot has to be observation only.
    stats.tokens = b ? projectedTokens(ctx, state, b) : 0;
  },
};

/** The behaviours defined in this module, for registration in behaviour.ts. */
export const EDGE_BEHAVIOURS: ComponentBehaviour[] = [cdn, ratelimiter];

/* Re-exported for the verification harness; not used by the engine. */
export type { BucketState };
export { limitBurst, limitRate };
export type { BehaviourCtx, NodeStateLike, ReqLike };

