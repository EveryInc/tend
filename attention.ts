#!/usr/bin/env bun
import { runAttentionCli } from "./server/cli";

await runAttentionCli(process.argv.slice(2));
