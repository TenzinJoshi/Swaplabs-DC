# SwapLabs

SwapLabs is a local skill-exchange platform inspired by RelaySkills. This repository contains the app source, original SwapLabs branding and acknowledgement pages, and synthetic demo fixtures. It does not include local member accounts, message attachments, profile uploads, or runtime databases.

## Run locally

Requirements: Node.js 20 or newer, Python 3, and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm start
```

The app is served at [http://localhost:8000](http://localhost:8000). The first launch builds the local Worker, applies the checked-in database migrations, and creates a fresh local database and media store. Register a new account in the app. On macOS, run `chmod +x "Start SwapLabs.command"` once if you want to launch it by double-clicking that file.

Local database, media, Wrangler state, and credentials belong on your computer. They are ignored by Git. Email delivery and Google sign-in are not configured in this local app. Live calls between separate networks may need a TURN relay.

## Checks

With the app running, execute:

```sh
pnpm check
```

This checks the local API, all site pages, in-site links, and local assets.

## Project map

- HTML pages live in the repository root.
- `styles/` contains the shared design system and responsive page styles.
- `scripts/` contains browser behavior, local startup, and Worker build tools.
- `server/` and `drizzle/` contain the local Worker and database migrations.
- `assets/` contains site imagery, fonts, and icon resources.
- `tests/` contains the local functional check.

The repository includes synthetic demo records marked `DEMO`; these are not real members or events. Keep local account databases, `.dev.vars`, `.original-swaplabs/`, `data/`, and `uploads/` private.
