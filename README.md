# Webhook Catcher

A tiny self-hosted webhook.site replacement. No dependencies, no request limits.

- **Sessions**: click **+ New session** for a fresh webhook URL. Each session has its own request list.
- **Webhook URL**: `https://<your-service>.onrender.com/hook/<sessionId>`. Any method, any sub-path (`/hook/<id>/stripe/events`), any body.
- **Live list**: new requests show up within about 2 seconds. Click one to see the method, query, headers and body (JSON gets pretty-printed, forms get parsed, binary gets base64).
- **Export for chat**: **Copy for chat** copies the request as clean Markdown. You can also download one request or the whole session as `.md` or `.json`.

## Deploy on Render

1. Push this folder to a GitHub repo.
2. Render → New → Web Service → pick the repo.
   - Runtime: Node
   - Build command: `echo no build step`
   - Start command: `node server.js`
   - Health check path: `/healthz`
3. Set the env var `ADMIN_PASSWORD` to protect the UI (the browser will ask for it; any username works). The `/hook/...` endpoints stay public so senders can reach them.

You can also use `render.yaml` as a Blueprint. It generates a random `ADMIN_PASSWORD` for you.

## Env vars (all optional)

| Var | Default | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | _(none)_ | Basic-auth password for the UI/API |
| `RESPONSE_STATUS` | `200` | HTTP status returned to webhook senders |
| `MAX_BODY_BYTES` | `10485760` | Max body stored per request (10 MB) |
| `MAX_REQUESTS_PER_SESSION` | `1000` | Oldest requests are dropped past this |
| `MAX_SESSIONS` | `50` | Oldest sessions are dropped past this |

## Caveats

- **Storage is in memory.** A redeploy or restart wipes everything, so download what you need. Session URLs still work after a restart because unknown IDs get recreated automatically.
- **Free plan spin-down**: after about 15 minutes idle, the first request can take around 30–60 seconds to wake the service. Some senders time out and retry, and spin-down also clears memory. Use the Starter plan if you need it always on.

## Run locally

```
node server.js        # http://localhost:3000
```
