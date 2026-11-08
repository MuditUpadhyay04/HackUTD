# Photon test bot (throwaway)

Text the Photon line from your phone and get Beat the Shutdown status back. Temporary until the backend exists.
To remove it: delete this folder and the `beat-the-shutdown-test` project in Photon.

1. Copy `.env.example` to `.env` and paste `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET` (Photon > Configure > Copy). Get them from Gurneal privately; this repo is public, so never commit `.env`.
2. `npm install && npm start` (the console must be running; set CONSOLE_URL in `.env`).
3. Text the line: `status`, `alerts` or `help`.
