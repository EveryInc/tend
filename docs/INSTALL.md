# Install

## From Source

```sh
pnpm install
pnpm start
```

Open:

```text
http://127.0.0.1:4321
```

The local API listens on:

```text
http://127.0.0.1:4332
```

The local MCP endpoint is:

```text
http://127.0.0.1:4332/mcp
```

## Build A Bun Binary

```sh
pnpm build
pnpm attention:build
./dist-bin/attention start
```

The binary serves built UI assets, API, and MCP from `http://127.0.0.1:4332`.

## Codex Setup

```sh
pnpm attention -- setup codex
```

Copy the printed MCP URL and setup prompt into Codex Desktop.

## Health Check

```sh
pnpm attention -- doctor
pnpm attention -- status
```
