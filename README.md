# FlytBase Customer Cockpit

A lightweight account-intelligence dashboard for FlytBase customer teams. The Express server serves a responsive browser UI, reads cached CRM data, and refreshes it through the MCP service on a rate-limited schedule.

## Features

- Portfolio dashboard with account search, pipeline and telemetry summaries.
- Account briefing for backed and unbacked opportunities, decision makers, next steps, risks, and open questions.
- Source links that open the evidence behind account insights.
- Activity form that queues notes and risks for MCP.
- Persistent local cache in `data/store.json`.

## Requirements

- Node.js 18 or newer.
- An MCP access token (`AQ_TOKEN`) for live CRM data.

## Run locally

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a `.env` file in the project root and add your MCP token:

   ```dotenv
   AQ_TOKEN=your_mcp_access_token
   ```

   Keep this file private; `.env` is ignored by Git.

3. Start the server:

   ```sh
   node server.js
   ```

4. Open [http://localhost:3000](http://localhost:3000).

Set `PORT` in the environment to use a different local port. Without a valid `AQ_TOKEN`, the server can serve the page, but live MCP data and note writes will not work.

## API

- `GET /api/crm` — returns the current cached dashboard state.
- `POST /api/notes` — queues an account note. Send JSON with `account`, `kind`, `title`, and `text`.

The MCP scheduler spaces calls to respect the service's one-call-per-minute limit. New notes are queued until the next available call slot.

## Local data and privacy

Runtime cache files, account exports, inspection output, `.env`, and `node_modules` are excluded from Git. The cache can contain customer and account information; do not commit or share it. The application stores its cache locally under `data/`.

## Project layout

```text
.
├── public/
│   └── index.html       # Dashboard UI
├── server.js            # Express API and MCP scheduler
├── fetch_accounts.js    # One-time account export helper
├── fetch_details.js     # Cached account detail fetch helper
├── package.json
└── package-lock.json
```
