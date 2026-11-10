# Archisys

A discrete-event system design simulator where every number is measured.
Build a distributed system, load it until it breaks, and watch why.

## Overview

Archisys lets you put load balancers, caches, databases, queues and other components on a canvas, wire them into a system, and drag the traffic up until something gives.

What you see while it happens is a real discrete-event simulation: latency percentiles climbing, queues filling, circuit breakers tripping, and systems collapsing into retry storms, all measured from individual simulated requests rather than drawn to look plausible.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) (v20+ recommended)
- `npm`

### Installation & Development

```bash
# Install dependencies
npm install

# Start local development server
npm run dev

# Build for production
npm run build

# Run linter
npm run lint

# Typecheck
npm run typecheck
```

Open `http://localhost:5173` in your browser.

## Architecture

- **`src/sim`**: The pure discrete-event simulation engine. Contains zero DOM and zero React dependencies.
  - `engine.ts`: Core event queue loop and time advancement.
  - `heap.ts`: Priority queue for discrete simulation events.
  - `tally.ts`: Exact latency percentile rings and metric aggregations.
  - `behaviour-*.ts`: Behaviour logic for control, storage, resilience, messaging, and data nodes.
- **`src/components`**: React components including the interactive SVG canvas, metrics strip, inspector drawer, and presets.
- **`src/App.tsx`**: Main UI coordinator running a 60fps animation frame loop while throttling state synchronization to 10Hz.

## Features

- **30+ System Design Components**: Databases, caches, API gateways, load balancers, queues, workers, circuit breakers, and more.
- **Deterministic Simulation**: Seeded pseudo-random generation guarantees repeatable runs.
- **Real Percentiles**: Latencies are tracked in ring buffers for true p50, p90, and p99 metrics.
- **Pre-built Presets**: Worked examples demonstrating retry storms, cache stampedes, read-replica lag, and microservice architectures.
