# Secret Network TUI iteration

Same public-chain snapshot backend as the first pass, but the frontend is now deliberately TUI-first.

## UI direction

- no primary data tables
- split panes
- compact key/value telemetry
- live event feed
- interpretation pane
- governance inspector
- source-health pane
- keyboard-style nav cues
- minimal chrome, no rounded SaaS cards

## Run

Requires Node 18+.

```bash
node server.mjs
```

Open:

```text
http://127.0.0.1:4173
```

Optional alternate LCD:

```bash
SECRET_LCD=https://your-lcd.example node server.mjs
```

## Data model

The browser still only calls `/api/snapshot`.

The local server handles:
- latest block: 4s cache
- staking / validators / governance: 60s cache
- inflation: 10m cache
- tx lookup: only once per new block height
- stale-good fallback for secondary endpoint failures
