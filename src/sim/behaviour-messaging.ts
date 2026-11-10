import type { NodeStats } from './types';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import type { AdmitAction, ComponentBehaviour } from './behaviour';
import { clamp01 } from './behaviour';

/**
 * A count from config, floored and held between `min` and `max`.
 *
 * `Infinity` was as much a hole as `NaN`: it is a number and it is not NaN,
 * so it passed the guard, survived `Math.floor`, and reached the loops that
 * build one structure per unit. Those do not fail on it, they simply never
 * finish.
 */
function clampInt(
  v: number | undefined,
  min: number,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  const n = Math.floor(v);
  return n < min ? min : n > max ? max : n;
}

/* ================================================================== *
 * pubsub -- fan-out of one publish to every subscriber
 * ================================================================== */

/**
 * The lesson is AMPLIFICATION. One publish becomes one delivery per
 * subscriber edge, all detached and all independent: a slow subscriber
 * queues and sheds at its own node without delaying the others or the
 * publisher, but the total work in the system is N times what the
 * publisher thinks it sent. Wiring five subscribers onto a 100 rps
 * publisher quietly makes 500 rps of load, and the deliveryRate readout is
 * that multiplication printed as a number.
 *
 * Unlike the streambroker there is no cursor, no retention and no pacing:
 * delivery is immediate and at-most-once. If a subscriber cannot keep up
 * the excess is shed at the subscriber, not remembered here, which is the
 * honest difference between a topic and a log.
 */
const pubsub: ComponentBehaviour = {
  kind: 'pubsub',
  // It acks the publisher; each delivery is detached.
  blocksOnDownstream: false,
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: false,

  onAdmit: () => 'passthru',

  onServiceComplete(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike) {
    for (let i = 0; i < state.out.length; i++) {
      if (ctx.emitDetached(state, state.out[i], req.key)) {
        ctx.countCustom(state, 'delivered', 1);
      }
    }
    return 'complete';
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    stats.fanout = state.out.length;
    const delivered = ctx.counterRate(state, 'delivered');
    stats.deliveryRate = delivered;
    stats.publishAmplification = delivered;
  },
};

/* ================================================================== *
 * websocket -- capacity measured in CONNECTIONS HELD, not requests served
 * ================================================================== */

/**
 * A long-lived-connection gateway. Every accepted connection occupies one
 * of `instances * capacity` slots for `connectionMs` of simulated time,
 * regardless of how quickly its handshake was served. By Little's law the
 * gateway settles at `rps * connectionMs / 1000` concurrent connections,
 * so a chat gateway taking a mere 40 conn/s with 30-second sessions is
 * holding 1200 connections, and THAT number, not the request rate, is what
 * it saturates on. This is why chat systems shard by connection count and
 * why Discord's gateway tier looks nothing like its API tier.
 *
 * A connection that finds every slot held is refused as 'conn-refused'
 * immediately; there is no queue to wait in, because a socket you cannot
 * accept is a socket the client retries against some other gateway.
 *
 * Expiry is lazy and exact: expiries are absolute simulated times in FIFO
 * order (the hold time is a constant read from config at accept time), so
 * releasing them at the next admission reproduces identically whatever the
 * frame cadence was.
 */
interface WsExt {
  /** Absolute expiry time of each open connection, oldest first. */
  expiry: number[];
  /** Read cursor into `expiry`, so release is O(1). */
  head: number;
}

function wsExt(state: NodeStateLike): WsExt {
  return state.ext as WsExt;
}

function wsOpen(ext: WsExt): number {
  return ext.expiry.length - ext.head;
}

/** Drop every connection whose lifetime has ended, as of `now`. */
function wsExpire(ext: WsExt, now: number): void {
  const q = ext.expiry;
  while (ext.head < q.length && q[ext.head] <= now) ext.head++;
  if (ext.head > 64 && ext.head * 2 >= q.length) {
    q.splice(0, ext.head);
    ext.head = 0;
  }
}

/** Open connections as of `now`, WITHOUT mutating: for pure snapshot reads. */
function wsOpenProjected(ext: WsExt, now: number): number {
  const q = ext.expiry;
  let head = ext.head;
  while (head < q.length && q[head] <= now) head++;
  return q.length - head;
}

const websocket: ComponentBehaviour = {
  kind: 'websocket',
  // Its resource is connection lifetime, not a thread per call.
  blocksOnDownstream: false,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  // Slot bookkeeping is connection-based and lives in `ext`; the engine's
  // busy/waiting pair never sees it, so there is nothing for it to pump.
  pump: 'none',
  creditsJoinCompletion: true,
  // One unit per instance; the waterline is connection occupancy, fed to the
  // engine through reportOccupancy below.
  instanceModel: 'slots',
  scaleField: 'instances',
  // A connection slot is released by its expiry timer, not by any request
  // finishing, so the engine cannot say which machine holds it.
  slotsOutliveService: true,

  initState(): WsExt {
    return { expiry: [], head: 0 };
  },

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const ext = wsExt(state);
    wsExpire(ext, ctx.now);

    const cap = ctx.effectiveCapacity(state);
    if (wsOpen(ext) >= cap) {
      ctx.countCustom(state, 'connRefused', 1);
      ctx.reject(state, req, 'conn-refused');
      return 'handled';
    }

    const holdMs = Math.max(0, state.config.connectionMs ?? 30000);
    ext.expiry.push(ctx.now + holdMs);
    ctx.countCustom(state, 'connected', 1);

    // The HANDSHAKE is served now (serviceMs), and the request continues
    // downstream (session setup, auth) like any other call; the connection
    // slot stays held long after the handshake resolved, which is the whole
    // resource model. Nothing to do on drain: release is time-based.
    ctx.serveWithin(state, req, wsNoopDrain);
    return 'handled';
  },

  onTick(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = wsExt(state);
    wsExpire(ext, ctx.now);
    ctx.reportOccupancy(state, wsOpen(ext), ctx.effectiveCapacity(state));
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const ext = wsExt(state);
    const open = wsOpenProjected(ext, ctx.now);
    stats.connectionsOpen = open;
    stats.maxConnections = ctx.effectiveCapacity(state);
    stats.connectRate = ctx.counterRate(state, 'connected');
    stats.connectionRejectRate = ctx.counterRate(state, 'connRefused');
    // The generic in-flight meter means "connections held" here; the
    // handshake count is a detail nobody sizes a gateway by.
    stats.inFlight = open;
  },
};

function wsNoopDrain(): void {
  // Connection slots are released by time, in wsExpire; the handshake
  // finishing frees nothing.
}

/* ================================================================== *
 * apigateway -- routing, auth and rate limiting in one front door
 * ================================================================== */

/**
 * The front door of a real API: one component that authenticates, rate
 * limits, and routes to whichever backend owns the path. Mechanically it is
 * a token bucket (reusing rateLimitRps/burst), an auth check (authFailRate,
 * refused as 'unauthorized'), and a weighted single-edge router (edge
 * weights are the route table), in front of real slots whose serviceMs is
 * the gateway's own processing cost.
 *
 * Order at the door is bucket first, then auth: a burst of bad credentials
 * still consumes rate-limit tokens, as it does in life, and the ordering is
 * fixed so the RNG stream never depends on which check happens to fail.
 */
interface GatewayBucket {
  tokens: number;
  lastRefillMs: number;
  lastBurst: number;
}

function gwRate(state: NodeStateLike): number {
  const r = state.config.rateLimitRps;
  return r !== undefined && r > 0 ? r : 0;
}

function gwBurst(state: NodeStateLike): number {
  const b = state.config.burst;
  if (b !== undefined && b > 0) return b;
  const r = gwRate(state);
  return r > 0 ? r : 1;
}

/** Continuous refill against elapsed simulated time; same math as ratelimiter. */
function gwRefill(ctx: BehaviourCtx, state: NodeStateLike, b: GatewayBucket): void {
  const burst = gwBurst(state);
  if (burst !== b.lastBurst) {
    if (b.tokens > burst) b.tokens = burst;
    b.lastBurst = burst;
  }
  const elapsed = ctx.now - b.lastRefillMs;
  if (elapsed <= 0) return;
  b.lastRefillMs = ctx.now;
  const rate = gwRate(state);
  if (rate <= 0) return;
  b.tokens += (elapsed / 1000) * rate;
  if (b.tokens > burst) b.tokens = burst;
}

/** Bucket level as of now, without mutating: snapshot() must stay pure. */
function gwProjectedTokens(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  b: GatewayBucket,
): number {
  const burst = gwBurst(state);
  let tokens = b.tokens > burst ? burst : b.tokens;
  const rate = gwRate(state);
  const elapsed = ctx.now - b.lastRefillMs;
  if (rate > 0 && elapsed > 0) {
    tokens += (elapsed / 1000) * rate;
    if (tokens > burst) tokens = burst;
  }
  return tokens;
}

const apigateway: ComponentBehaviour = {
  kind: 'apigateway',
  // An event-loop proxy: its slot is routing work, not a thread per call.
  blocksOnDownstream: false,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'own',
  creditsJoinCompletion: true,
  instanceModel: 'slots',
  scaleField: 'instances',

  initState: (state): GatewayBucket => ({
    tokens: gwBurst(state),
    lastRefillMs: 0,
    lastBurst: gwBurst(state),
  }),

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const b = state.ext as GatewayBucket;
    gwRefill(ctx, state, b);

    if (gwRate(state) > 0) {
      if (b.tokens < 1) {
        ctx.countCustom(state, 'throttled', 1);
        ctx.reject(state, req, 'throttled');
        return 'handled';
      }
      b.tokens -= 1;
    }

    const authFail = clamp01(state.config.authFailRate ?? 0);
    if (authFail > 0 && ctx.roll() < authFail) {
      ctx.countCustom(state, 'authRejected', 1);
      ctx.reject(state, req, 'unauthorized');
      return 'handled';
    }

    ctx.countCustom(state, 'admitted', 1);
    // Real slots and a real queue: auth and routing cost serviceMs each.
    return 'serve';
  },

  // The route table: exactly one backend per request, chosen by edge weight.
  route: () => 'one',
  pickEdge: (ctx, _state, _req, out) => ctx.pickWeightedOrLeastLoaded(out),

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const b = state.ext as GatewayBucket | null;
    stats.admittedRate = ctx.counterRate(state, 'admitted');
    stats.throttledRate = ctx.counterRate(state, 'throttled');
    stats.authRejectRate = ctx.counterRate(state, 'authRejected');
    stats.tokens = b ? gwProjectedTokens(ctx, state, b) : 0;
  },
};

/* ================================================================== *
 * lambda -- serverless: instant scale, cold starts
 * ================================================================== */

/**
 * A function-as-a-service pool. There is no fixed fleet: an invocation that
 * finds a WARM idle instance starts immediately; one that does not pays
 * `coldStartMs` on top of its service time while the platform provisions
 * an instance. Finished instances sit warm for `keepWarmMs` and are then
 * reclaimed, and reuse is most-recent-first (LIFO), which is what real
 * platforms do and is exactly why the warm pool shrinks to fit steady
 * traffic and gets caught flat by a burst.
 *
 * The visible consequences, all real in the numbers: an idle lambda's
 * first request is slow; a cron burst arriving at a cold pool pays
 * coldStartMs almost across the board (watch coldStartRate spike on the
 * cron's period); and beyond `maxConcurrency` the platform simply
 * throttles, because a lambda has no queue.
 */
interface LambdaExt {
  /** Absolute reclaim time of each warm idle instance, oldest first. */
  warmExpiry: number[];
  /** Read cursor into warmExpiry: entries before it are gone. */
  head: number;
  /** Invocations running right now. */
  busy: number;
}

function lambdaExt(state: NodeStateLike): LambdaExt {
  return state.ext as LambdaExt;
}

function lambdaLimit(state: NodeStateLike): number {
  return clampInt(state.config.maxConcurrency, 1, 40);
}

/** Reclaim warm instances whose keep-alive ended, as of `now`. */
function lambdaReap(ext: LambdaExt, now: number): void {
  const q = ext.warmExpiry;
  while (ext.head < q.length && q[ext.head] <= now) ext.head++;
  if (ext.head > 64 && ext.head * 2 >= q.length) {
    q.splice(0, ext.head);
    ext.head = 0;
  }
}

/** Warm idle count as of `now` without mutating, for pure snapshot reads. */
function lambdaWarmProjected(ext: LambdaExt, now: number): number {
  const q = ext.warmExpiry;
  let head = ext.head;
  while (head < q.length && q[head] <= now) head++;
  return q.length - head;
}

const lambda: ComponentBehaviour = {
  kind: 'lambda',
  // An invocation awaiting a call still counts against concurrency and is
  // still billed, so a slow dependency throttles the function.
  blocksOnDownstream: true,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: true,
  // One unit per live instance, busy or warm; the stack GROWS WITH LOAD,
  // which is the one picture that says "serverless" truthfully.
  instanceModel: 'custom',

  initState: (): LambdaExt => ({ warmExpiry: [], head: 0, busy: 0 }),

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const ext = lambdaExt(state);
    lambdaReap(ext, ctx.now);

    if (ext.busy >= lambdaLimit(state)) {
      ctx.countCustom(state, 'throttled', 1);
      ctx.reject(state, req, 'throttled');
      return 'handled';
    }

    const warm = ext.warmExpiry.length - ext.head;
    if (warm > 0) {
      // Reuse the most recently freed instance (LIFO), leaving the oldest to
      // expire; this is why keep-warm does not accumulate a large fleet.
      ext.warmExpiry.pop();
      ctx.countCustom(state, 'warmStart', 1);
    } else {
      ctx.countCustom(state, 'coldStart', 1);
      // Booked as the function's own work: starting the runtime and running
      // its init code, which a slowed function does slowly too.
      ctx.addServiceDelay(req, Math.max(0, state.config.coldStartMs ?? 350));
    }

    ext.busy += 1;
    ctx.serveWithin(state, req, onLambdaDrained);
    return 'handled';
  },

  onTick(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = lambdaExt(state);
    lambdaReap(ext, ctx.now);
    ctx.reportOccupancy(state, ext.busy, lambdaLimit(state));
  },

  reportInstances(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = lambdaExt(state);
    const warm = lambdaWarmProjected(ext, ctx.now);
    // Cap the drawn stack; the badge carries the true count past this.
    const total = Math.min(ext.busy + warm, 64);
    const out = lambdaReport;
    out.length = total;
    for (let i = 0; i < total; i++) out[i] = i < ext.busy ? 1 : 0;
    ctx.reportInstances(state, out, 0);
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const ext = lambdaExt(state);
    const cold = ctx.counterRate(state, 'coldStart');
    const warmStarts = ctx.counterRate(state, 'warmStart');
    const started = cold + warmStarts;
    stats.coldStartRate = started > 0 ? cold / started : 0;
    stats.coldStartsPerSec = cold;
    stats.warmIdle = lambdaWarmProjected(ext, ctx.now);
    // An invocation waiting on a call it made is still running and still
    // counts against maxConcurrency, so runningNow and the meter keep it.
    // inFlight is the part doing work, the same meaning it has elsewhere;
    // the engine publishes the rest as waitingOnDownstream.
    stats.runningNow = ext.busy;
    stats.inFlight = ext.busy > state.parked ? ext.busy - state.parked : 0;
    // The 'throttled' counter was already being booked at admission; publish
    // it so the UI can show refusals instead of inferring them from errors.
    stats.throttledRate = ctx.counterRate(state, 'throttled');
  },
};

/** Scratch for the lambda's instance vector; ctx.reportInstances copies it. */
const lambdaReport: number[] = [];

function onLambdaDrained(ctx: BehaviourCtx, state: NodeStateLike, _req: ReqLike): void {
  const ext = lambdaExt(state);
  if (ext.busy > 0) ext.busy -= 1;
  // The freed instance stays warm for keepWarmMs from THIS moment.
  const keep = Math.max(0, state.config.keepWarmMs ?? 12000);
  ext.warmExpiry.push(ctx.now + keep);
}

/* ================================================================== *
 * cron -- scheduled batch load
 * ================================================================== */

/**
 * A job on a clock. Every `intervalMs` it dumps `batchSize` detached
 * requests down EACH outgoing edge, effectively simultaneously; between
 * firings it does nothing at all. That burst shape is the entire lesson:
 * a database sized comfortably for its steady interactive load falls over
 * every time the report job lands on it, and the graphs show interactive
 * p95 spiking on the cron's period, which is exactly the page a real
 * on-call gets at midnight.
 *
 * Firing happens from onTick, so the instant is quantised to the advance()
 * boundary; the same latitude the autoscaler's decisions already take, and
 * fully replayable for a given advance() pattern. Message keys cycle a
 * deterministic counter rather than drawing randomness, so a cron never
 * perturbs anyone else's RNG stream. If firings were missed (a long stall),
 * ONE batch fires and the schedule resumes from now; a real cron with
 * `skip` overlap policy, not a backlog bomb.
 */
interface CronExt {
  /** Absolute simulated time of the next firing; -1 until initialised. */
  nextFireMs: number;
  /** Total requests emitted since sim start. */
  emitted: number;
  /** Deterministic key sequence for emitted messages. */
  keySeq: number;
}

function cronExt(state: NodeStateLike): CronExt {
  return state.ext as CronExt;
}

function cronInterval(state: NodeStateLike): number {
  const v = state.config.intervalMs;
  return v !== undefined && v >= 250
    ? Math.floor(v)
    : v !== undefined && v > 0
      ? 250
      : 20000;
}

/** Requests per edge per firing, bounded so a slider cannot wedge the heap. */
function cronBatch(state: NodeStateLike): number {
  return Math.min(clampInt(state.config.batchSize, 1, 50), 2000);
}

const cron: ComponentBehaviour = {
  kind: 'cron',
  // It emits detached work and waits on none of it.
  blocksOnDownstream: false,
  servesRequests: false,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  pump: 'none',
  creditsJoinCompletion: false,

  initState: (): CronExt => ({ nextFireMs: -1, emitted: 0, keySeq: 0 }),

  // Traffic INTO a cron is a wiring mistake, same as into an autoscaler.
  onAdmit: (ctx, state, req) => {
    ctx.reject(state, req, 'no-route');
    return 'handled';
  },

  onTick(ctx: BehaviourCtx, state: NodeStateLike): void {
    const st = cronExt(state);
    const interval = cronInterval(state);
    if (st.nextFireMs < 0) {
      // First fire one full interval in, so a fresh topology settles first
      // and the burst reads as an event rather than as part of startup.
      st.nextFireMs = ctx.now + interval;
      return;
    }
    if (ctx.now < st.nextFireMs) return;

    const batch = cronBatch(state);
    for (let i = 0; i < state.out.length; i++) {
      const edge = state.out[i];
      for (let n = 0; n < batch; n++) {
        if (!ctx.emitDetached(state, edge, st.keySeq)) break;
        st.keySeq = (st.keySeq + 1) % 64;
        st.emitted += 1;
      }
    }
    ctx.countCustom(state, 'fired', 1);
    st.nextFireMs = ctx.now + interval;
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const st = state.ext as CronExt | null;
    if (!st) return;
    stats.nextFireInMs =
      st.nextFireMs < 0 ? cronInterval(state) : Math.max(0, st.nextFireMs - ctx.now);
    stats.batchEmitted = st.emitted;
    // What the next firing will dump downstream, all edges together. A pure
    // read of config and wiring, so the readout can say "burst 150" before
    // the burst ever lands.
    stats.burstSize = cronBatch(state) * state.out.length;
  },
};

/** The behaviours defined in this module, for registration in behaviour.ts. */
export const MESSAGING_BEHAVIOURS: ComponentBehaviour[] = [
  pubsub,
  websocket,
  apigateway,
  lambda,
  cron,
];

/* Re-exported for the verification harness; not used by the engine. */
export type { WsExt, LambdaExt, CronExt };
