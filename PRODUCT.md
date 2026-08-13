# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are casual players, roughly ages 12–40, who want a quick, low-friction game of tic-tac-toe against another person or a bot. There is no account creation — a player identifies themselves with just a nickname for the session.

## Product Purpose

An online tic-tac-toe app where entering a nickname drops a player straight into a lobby. From the lobby they can challenge another online human player, or play instantly against one of three bots of increasing difficulty. Success is a fast, frictionless match with minimal setup.

## Positioning

Unlike plain pass-and-play tic-tac-toe or a blind random-matchmaking queue, this app shows a live lobby of who is available right now — real people online, plus three difficulty-tiered bots — and lets the player pick and challenge a specific opponent.

## Operating Context

- Entry flow: open the app → enter a nickname (no account/auth) → land in a lobby.
- Lobby: shows other online human players and three bots of different difficulty, all challengeable.
- A match is a single game of 3x3 tic-tac-toe with a vanishing-marks variant between two participants (human vs human, or human vs bot): each player holds at most 3 marks on the board at once, and placing a 4th removes their own oldest mark before the win check. See `CONTEXT.md` for the full rule set.

## Capabilities and Constraints

- No accounts or persistent identity — a nickname is scoped to the session only.
- Requires real-time presence in the lobby and a live challenge/response flow into a match. The specific real-time transport (WebSockets, polling, a hosted realtime service, etc.) is not yet chosen — an implementation decision for build time, not a product fact.
- Three bot opponents at different difficulty levels are a required capability, not a future nice-to-have.
- Explicitly out of scope for now: persistent stats/match history, chat, spectating. May be revisited later, but don't build toward it yet.
- Deployment target undecided: Docker (Dockerfile/docker-compose already present in the repo) and Vercel are both acceptable; don't lock work to one over the other.

## Evidence on Hand

None. No existing designs, copy, logos, or brand assets beyond the default `create-next-app` scaffold currently in the repo.

## Product Principles

- Zero-friction entry: a player should be playing within seconds of opening the app, nickname only.
- Opponent choice over blind matchmaking: the lobby lets a player pick who they play, human or bot.
- Bots are a first-class, always-available option, not just a stand-in for missing multiplayer.
- Keep scope minimal: resist adding accounts, stats, chat, or spectating until explicitly asked for.

## Accessibility & Inclusion

No product-specific requirement established yet.
