import { createInterface } from "node:readline";

const scenario = process.argv[2];
const threadId = "thread-inbox";
const turnId = "turn-one";
const item = { type: "mcpToolCall", id: "tool-item", server: "test-mail", tool: "send", arguments: { to: "reader@example.test", body: "Exact body." } };
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method: string, params: unknown) => send({ method, params });
let cancelled = false;
let responses = 0;
const complete = (ok = true) => notify("turn/completed", { threadId, turn: { id: turnId, status: ok ? "completed" : "failed" } });
const question = (overrides: Record<string, unknown> = {}, id = 88) => send({ id, method: "item/tool/requestUserInput", params: {
  threadId, turnId, itemId: item.id,
  questions: [{ id: "send", question: "Send this exact message?", options: [
    { label: "Send once", description: "Send only this message." },
    { label: "Do not send", description: "Leave it unsent." },
  ] }], ...overrides,
} });

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    if (scenario === "disconnect-initialize") process.exit(1);
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/resume") {
    const changesPolicy = ["approvalPolicy", "approvalsReviewer"].some((key) => key in message.params);
    send(changesPolicy ? { id: message.id, error: { message: "Must inherit host approval policy" } } : { id: message.id, result: {} });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId } } });
    notify("turn/started", { threadId, turn: { id: turnId } });
    if (scenario !== "missing-tool") notify("item/started", { threadId, turnId, item });
    if (scenario === "uncorrelated-elicitation") {
      send({ id: 88, method: "mcpServer/elicitation/request", params: {
        threadId, turnId, serverName: item.server, mode: "form", message: "Approve?",
        _meta: { itemId: item.id }, requestedSchema: { type: "object", properties: {} },
      } });
    } else if (scenario === "missing-item") question({ itemId: undefined });
    else if (scenario === "wrong-thread") question({ threadId: "other-thread" });
    else if (scenario === "wrong-turn" || scenario === "reused-turn") {
      if (scenario === "reused-turn") {
        notify("turn/started", { threadId, turn: { id: "turn-two" } });
        notify("item/started", { threadId, turnId: "turn-two", item });
      }
      question({ turnId: "turn-two" });
    } else {
      question();
      if (scenario === "duplicate") question();
      if (scenario.startsWith("cancel-") || scenario === "changed-arguments") setTimeout(() => {
        cancelled = true;
        if (scenario === "cancel-request") notify("serverRequest/resolved", { threadId, requestId: 88 });
        if (scenario === "cancel-item") notify("item/completed", { threadId, turnId, item });
        if (scenario === "changed-arguments") notify("item/started", { threadId, turnId,
          item: { ...item, arguments: { ...item.arguments, body: "Changed body." } } });
        if (scenario === "cancel-turn") complete();
        else setTimeout(() => complete(responses === 0), 40);
      }, 30);
      if (scenario === "disconnect") setTimeout(() => process.exit(1), 30);
    }
  } else if (message.id === 88 && !message.method) {
    responses++;
    if (cancelled) { complete(false); continue; }
    const expected = scenario === "uncorrelated-elicitation" ? { action: "decline", content: null }
      : ["missing-item", "missing-tool", "wrong-thread", "wrong-turn", "reused-turn"].includes(scenario) ? { answers: {} }
      : { answers: { send: { answers: ["Send once"] } } };
    const valid = JSON.stringify(message.result) === JSON.stringify(expected) && responses === 1;
    if (scenario === "duplicate") { question(); setTimeout(() => complete(valid && responses === 1), 40); }
    else complete(valid);
  }
}
