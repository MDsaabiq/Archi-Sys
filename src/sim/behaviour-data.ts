/**
 * Data-tier component behaviours: replicated reads, and horizontal sharding.
 *
 * Both are pure registry entries -- they add no branch to the event loop. Each
 * keeps whatever internal structure it needs on `state.ext`, which the engine
 * allocates and then never looks at, and drives service through the ctx so its
 * timing, error rolls and timeouts are the same ones every other kind gets.
 *
 * They live in their own module rather than in behaviour.ts because both carry
 * real internal machinery (a per-key write clock, a set of independent
 * partitions) and folding that into the registry file would bury the small
 * declarative behaviours that make the registry readable.
 */
import type { NodeStats } from './types';
import type { BehaviourCtx, NodeStateLike, ReqLike } from './engine-types';
import type { AdmitAction, ComponentBehaviour } from './behaviour';

/** Keyspace the engine draws request keys from; mirrored here for sizing. */
const KEYSPACE = 64;

/* Fleet ceilings, each the maximum the inspector already offers for the
 * field, so nothing a reader can build is affected by them. */
const MAX_REPLICAS = 64;

/**
 * A count from config: floored, held at `min`, and capped at `max`.
 *
 * NaN fails every comparison, so `n < min` was false for it and a value that
 * is not a number used to pass through and size an array. Nothing here can
 * absorb that: `new Array(NaN)` throws outright, and a count in the billions
 * allocates until the tab stops rather than merely running slowly.
 */
function clampInt(v: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(v)) return min;
  const n = Math.floor(v);
  return n < min ? min : n > max ? max : n;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Scratch buffer for building an instance vector.
 *
 * A single module-level array shared by every node of every data-tier kind,
 * which is safe for exactly one reason: ctx.reportInstances() COPIES what it
 * is handed before returning, so the buffer's contents never have to survive
 * past the call that fills them. Nothing may retain what this returns.
 *
 * The alternative -- a per-node buffer -- would be one more allocation per
 * node held forever to save nothing, since the copy happens either way.
 */
let scratch: number[] = [];
function instanceScratch(n: number): number[] {
  if (scratch.length !== n) scratch.length = n;
  return scratch;
}

/* ================================================================== *
 * replica -- a read replica set behind a primary
 * ================================================================== */

/**
 * Per-node state for a replica set.
 *
 * `visibleAt[key]` is the simulated time at which the most recent write to
 * that key becomes visible on the replicas -- i.e. write completion plus the
 * replication lag. A read of that key before then is reading a replica that
 * has not caught up, which is precisely what a stale read is. Storing the
 * deadline rather than the write time means changing the lag slider affects
 * only writes issued after the change, which is how a real system behaves.
 */
interface ReplicaExt {
  /** Visibility deadline per key; -Infinity means "never written". */
  visibleAt: Float64Array;
  /** Read slots in use across the whole replica set. */
  readBusy: number;
  /** Write slots in use on the primary. */
  writeBusy: number;
  /** Reads waiting for a replica slot. */
  readQueue: ReqLike[];
  /** Writes waiting for a primary slot. */
  writeQueue: ReqLike[];
  /** Read cursors, so dequeue is O(1) without splice. */
  readHead: number;
  writeHead: number;
}

function replicaExt(state: NodeStateLike): ReplicaExt {
  return state.ext as ReplicaExt;
}

/** Total read slots: every replica serves reads in parallel. */
function readCapacity(state: NodeStateLike): number {
  return (
    clampInt(state.config.capacity, 1) *
    clampInt(state.config.replicaCount, 1, MAX_REPLICAS)
  );
}

/** Write slots: the primary alone, which is why writes do not scale. */
function writeCapacity(state: NodeStateLike): number {
  return clampInt(state.config.capacity, 1);
}

const replica: ComponentBehaviour = {
  kind: 'replica',
  // A store: an outgoing edge is a replication feed, not a query thread,
  // and its drain carries commit bookkeeping that must stay at service end.
  blocksOnDownstream: false,
  servesRequests: true,
  generatesLoad: false,
  pullsFromQueues: false,
  buffersForConsumers: false,
  // Admission, queueing and slot release are all handled inside onAdmit and
  // the drain callback, because reads and writes draw from two different
  // pools. The engine's single busy/waiting pair cannot express that.
  pump: 'none',
  creditsJoinCompletion: true,

  onDiscard(ctx: BehaviourCtx, state: NodeStateLike): void {
    // Both lines are emptied before anything is failed: failing a request
    // runs its caller's code, which may call back into the engine.
    const ext = replicaExt(state);
    const writes = ext.writeQueue;
    const reads = ext.readQueue;
    const writeHead = ext.writeHead;
    const readHead = ext.readHead;
    ext.writeQueue = [];
    ext.readQueue = [];
    ext.writeHead = 0;
    ext.readHead = 0;
    for (let i = writeHead; i < writes.length; i++) {
      if (writes[i]) ctx.fail(writes[i], 'no-route', 0);
    }
    for (let i = readHead; i < reads.length; i++) {
      if (reads[i]) ctx.fail(reads[i], 'no-route', 0);
    }
  },

  initState(_state: NodeStateLike): ReplicaExt {
    const visibleAt = new Float64Array(KEYSPACE);
    visibleAt.fill(-Infinity);
    return {
      visibleAt,
      readBusy: 0,
      writeBusy: 0,
      readQueue: [],
      writeQueue: [],
      readHead: 0,
      writeHead: 0,
    };
  },

  onAdmit(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): AdmitAction {
    const ext = replicaExt(state);

    // Classify read vs write ONCE, from a single RNG draw. A retry of the same
    // call re-draws, exactly as a real client re-issuing a request would.
    const isWrite = ctx.roll() >= clamp01(state.config.readFraction);
    ctx.markWrite(req, isWrite);

    const queue = isWrite ? ext.writeQueue : ext.readQueue;
    const head = isWrite ? ext.writeHead : ext.readHead;
    const busy = isWrite ? ext.writeBusy : ext.readBusy;
    const capacity = isWrite ? writeCapacity(state) : readCapacity(state);

    if (busy < capacity) {
      startReplicaService(ctx, state, req, isWrite);
      return 'handled';
    }

    // Reads and writes share one configured backlog; a full queue sheds.
    if (queue.length - head >= ctx.effectiveQueueLimit(state)) return 'shed';
    queue.push(req);
    return 'handled';
  },

  // A replica set is a primary plus N read replicas, and drawing it as one
  // box hides the reason adding replicas does not fix a write bottleneck.
  instanceModel: 'custom',

  /**
   * Unit 0 is the PRIMARY and reports the write pool's utilisation; units
   * 1..replicaCount are the read replicas.
   *
   * The read replicas all report the same number, and that is the honest
   * reading rather than a shortcut: the engine pools read slots across the
   * whole set, so a read is served by whichever replica is free and no
   * individual replica has a utilisation of its own. Splitting the pool's
   * load evenly across the drawn units says exactly that. What the vector
   * DOES separate -- the primary from the read set -- is the distinction that
   * carries the lesson, because it is where the two pools genuinely differ.
   */
  reportInstances(ctx: BehaviourCtx, state: NodeStateLike): void {
    const ext = replicaExt(state);
    const replicas = clampInt(state.config.replicaCount, 1, MAX_REPLICAS);
    const out = instanceScratch(replicas + 1);

    const writeCap = writeCapacity(state);
    out[0] = writeCap > 0 ? Math.min(ext.writeBusy / writeCap, 1) : 0;

    const readCap = readCapacity(state);
    const readUtil = readCap > 0 ? Math.min(ext.readBusy / readCap, 1) : 0;
    for (let i = 1; i <= replicas; i++) out[i] = readUtil;

    ctx.reportInstances(state, out, 0);
  },

  load(_ctx: BehaviourCtx, state: NodeStateLike): number {
    const ext = replicaExt(state);
    const work =
      ext.readBusy +
      ext.writeBusy +
      (ext.readQueue.length - ext.readHead) +
      (ext.writeQueue.length - ext.writeHead);
    return work / (readCapacity(state) + writeCapacity(state));
  },

  onTick(ctx: BehaviourCtx, state: NodeStateLike, _dtMs: number): void {
    // Publish occupancy on the engine's clock. Reads and writes draw from two
    // different pools held in `ext`, so state.busy stays 0 and the engine
    // would otherwise integrate this node's utilisation as permanently idle --
    // which does not merely blank the meter, it tells an autoscaler watching
    // this node to scale it DOWN while its queue is overflowing.
    const ext = replicaExt(state);
    ctx.reportOccupancy(
      state,
      ext.readBusy + ext.writeBusy,
      readCapacity(state) + writeCapacity(state),
    );
  },

  decorateStats(ctx: BehaviourCtx, state: NodeStateLike, stats: NodeStats): void {
    const fresh = ctx.counterRate(state, 'freshRead');
    const stale = ctx.counterRate(state, 'staleRead');
    const total = fresh + stale;
    stats.staleReadRate = total > 0 ? stale / total : 0;

    // Occupancy is the two pools together against their combined slots, so the
    // meter still means "how full is this thing".
    const ext = replicaExt(state);
    stats.queued =
      ext.readQueue.length - ext.readHead + (ext.writeQueue.length - ext.writeHead);
    stats.inFlight = ext.readBusy + ext.writeBusy;
  },
};

/**
 * Begin serving one request against the replica set.
 *
 * A write occupies a primary slot and, on completion, pushes this key's
 * visibility deadline out by the replication lag. A read occupies a replica
 * slot and is judged stale at the moment it is served.
 */
function startReplicaService(
  ctx: BehaviourCtx,
  state: NodeStateLike,
  req: ReqLike,
  isWrite: boolean,
): void {
  const ext = replicaExt(state);
  const key = req.key % KEYSPACE;

  if (isWrite) {
    ext.writeBusy++;
  } else {
    ext.readBusy++;
    // Judge staleness at service time: the replica answers from whatever it
    // holds right now. `visibleAt` is the write's arrival deadline on the
    // replicas, so "not yet visible" is exactly a stale read.
    const stale = ctx.now < ext.visibleAt[key];
    ctx.countCustom(state, stale ? 'staleRead' : 'freshRead', 1);
  }

  if (isWrite) {
    // Claim the key's visibility deadline BEFORE starting service. A
    // zero-millisecond service time completes synchronously inside
    // serveWithin(), so anything written afterwards would be set after the
    // request had already drained. The deadline is a lower bound here (it
    // ignores this write's own service time) and is pushed to its true value
    // when the write actually lands, in onReplicaDrained.
    const lag = state.config.replicationLagMs;
    const visible = ctx.now + (lag > 0 ? lag : 0);
    if (visible > ext.visibleAt[key]) ext.visibleAt[key] = visible;
  }

  ctx.serveWithin(state, req, onReplicaDrained);
}

/** A replica-set request finished its service time: free its slot, pull next. */
function onReplicaDrained(ctx: BehaviourCtx, state: NodeStateLike, req: ReqLike): void {
  const ext = replicaExt(state);
  if (req.isWrite) {
    if (ext.writeBusy > 0) ext.writeBusy--;
    // The write has now committed on the primary. Replication starts from
    // here, so this is the moment the real visibility deadline is known.
    const lag = state.config.replicationLagMs;
    const key = req.key % KEYSPACE;
    const visible = ctx.now + (lag > 0 ? lag : 0);
    if (visible > ext.visibleAt[key]) ext.visibleAt[key] = visible;
  } else if (ext.readBusy > 0) {
    ext.readBusy--;
  }
  pumpReplica(ctx, state);
}

/** Start whatever is waiting, up to each pool's own capacity. */
function pumpReplica(ctx: BehaviourCtx, state: NodeStateLike): void {
  const ext = replicaExt(state);

  while (
    ext.writeBusy < writeCapacity(state) &&
    ext.writeHead < ext.writeQueue.length
  ) {
    const req = ext.writeQueue[ext.writeHead];
    ext.writeQueue[ext.writeHead] = null as unknown as ReqLike;
    ext.writeHead++;
    compact(
      ext.writeQueue,
      () => ext.writeHead,
      (v) => (ext.writeHead = v),
    );
    startReplicaService(ctx, state, req, true);
  }
  while (ext.readBusy < readCapacity(state) && ext.readHead < ext.readQueue.length) {
    const req = ext.readQueue[ext.readHead];
    ext.readQueue[ext.readHead] = null as unknown as ReqLike;
    ext.readHead++;
    compact(
      ext.readQueue,
      () => ext.readHead,
      (v) => (ext.readHead = v),
    );
    startReplicaService(ctx, state, req, false);
  }
}

/** Drop a queue's dead prefix once it is mostly consumed. */
function compact(
  q: unknown[],
  getHead: () => number,
  setHead: (v: number) => void,
): void {
  const head = getHead();
  if (head > 64 && head * 2 >= q.length) {
    q.splice(0, head);
    setHead(0);
  }
}

export const DATA_BEHAVIOURS: ComponentBehaviour[] = [replica];
