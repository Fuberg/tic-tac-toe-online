# Self-hosted-сервер вместо Vercel

`README.md` по умолчанию указывает на деплой на Vercel, а `PRODUCT.md` оставлял целевую среду открытой (Docker и Vercel — оба приемлемы). Решили деплоить на арендованный self-hosted сервер через уже существующие `Dockerfile`/`docker-compose.yml`, а не на Vercel.

Причина: лобби/challenge/match — server-authoritative (см. `CONTEXT.md`) поверх Socket.IO, что требует постоянного долгоживущего процесса. Serverless-функции Vercel не держат такие соединения без стороннего realtime-вендора (Pusher/Ably/Supabase Realtime) — сервер арендовали именно чтобы обойтись без этого и сразу переиспользовать готовый Docker-сетап.
