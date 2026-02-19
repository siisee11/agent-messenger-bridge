# Discode Telemetry Proxy (Cloudflare Worker)

This Worker receives anonymous CLI usage events and forwards them to GA4 using Measurement Protocol.

## 1) Deploy the Worker

```bash
npx wrangler deploy --config workers/telemetry-proxy/wrangler.jsonc
```

Set the GA4 API secret once (or whenever rotated):

```bash
npx wrangler secret put GA4_API_SECRET --config workers/telemetry-proxy/wrangler.jsonc
```

## 2) Enable telemetry in CLI

Use your deployed Worker URL:

```bash
discode config --telemetry-endpoint https://discode-telemetry-proxy.<your-subdomain>.workers.dev
discode config --telemetry on
```

To disable:

```bash
discode config --telemetry off
```

## Payload contract

The CLI sends:

- `source`: fixed (`discode-cli`)
- `installId`: random local install identifier
- `version`, `platform`, `runtime`
- `events`: array of event objects (`name`, `params`)

The Worker sanitizes event names/params and forwards them as GA4 events.
