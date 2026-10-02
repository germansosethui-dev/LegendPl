# Legend Pl 2.0

## Persistent data on Render

The server uses PostgreSQL when `DATABASE_URL` is set. This is the recommended setup for Render so users, ELO, friends, chat, reports and match history survive restarts and redeploys.

Set a Render PostgreSQL database connection string as the service environment variable:

`DATABASE_URL=postgresql://...`

If `DATABASE_URL` is not set, the server falls back to `data/legendpl-data.json`. Render's normal filesystem is ephemeral, so that fallback does **not** survive a service restart/redeploy unless the service has a persistent disk mounted and `DATA_DIR` points to it.

## Main files

- `server.js` — API, Socket.IO, matchmaking, persistence and admin endpoints.
- `public/index.html` — login and application UI.
- `public/client.js` — client logic, queues, profiles, friends, chat and private messages.
- `public/admin.html` — admin interface.
- `public/styles.css` — UI styles.
