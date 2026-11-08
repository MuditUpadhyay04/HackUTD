# Photon: Backpressure on your phone

Text the Photon line and get the console's answers back, straight from the operator API (`apps/api`).
Advice only: nothing here approves or dispatches anything.

| Text | Reply |
| --- | --- |
| `status` | One line: pumps down, first shutdown, plan cost vs. doing nothing, what to inspect |
| `alerts` | Each pump failure (shutdown time, plan, cost) and each inspection |
| `handoff` | The agents' note for the next shift (latest agent run) |
| `agents` | Runs the Nemotron agents now and texts their handoff |
| `subscribe` / `stop` | Turn alert texts on or off: a text whenever a new pump failure or inspection appears, including when a new dataset (e.g. `test/`) is uploaded |
| `help` | The list |

## Run

1. `cp .env.example .env` and fill in `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` (Photon > Configure > Copy;
   ask Gurneal privately) and `API_URL` / `API_TOKEN` for the operator API. This repo is public: never commit `.env`.
2. `npm install`
3. `npm run check` prints every reply without the phone line (needs only the API).
4. `npm start`, then text the line `help`.

Subscriptions are kept in `.data/subscribers.json` (gitignored). `console.mts` holds the API calls and the wording;
`bot.mts` only connects the phone line.
