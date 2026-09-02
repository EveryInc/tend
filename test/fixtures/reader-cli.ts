import { appendFileSync } from "node:fs";

const adapter = process.env.TEND_TEST_READER_ADAPTER;
const calls = process.env.TEND_TEST_READER_CALLS;
if (!calls || (adapter !== "claude" && adapter !== "codex")) throw new Error("Reader fixture configuration is required.");
const args = process.argv.slice(2);
appendFileSync(calls, JSON.stringify(args) + "\n");
const auth = args[0] === "auth" || args[0] === "login";
if (auth && process.env.TEND_TEST_READER_STAGE === "generation") {
  console.log(adapter === "claude"
    ? JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" })
    : "Logged in using ChatGPT");
  process.exit(0);
}
const diagnostic = "OAuth session expired and could not be refreshed. private@example.test fixture-private-token";
console.log(JSON.stringify(adapter === "claude" ? { is_error: true, result: diagnostic } : { type: "error", message: diagnostic }));
process.exit(1);
