import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { NativeApprovalPrompt } from "../src/feed/NativeApprovals";
import type { NativeApprovalSubmission, NativeApprovalView } from "../shared/nativeApproval";

const ownsDom = typeof document === "undefined";
if (ownsDom) GlobalRegistrator.register();
afterEach(() => cleanup());
afterAll(() => { if (ownsDom) GlobalRegistrator.unregister(); });

const view: NativeApprovalView = { id: "native-1", feedId: "inbox", cardId: "card-1", cardTitle: "Reply to the reader",
  actionLabel: "Send reply", server: "test-mail", tool: "send", requestDigest: "exact-request",
  arguments: { to: "reader@example.test", body: "The exact reviewed reply." },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  questions: [{ id: "consent", question: "Send this message to reader@example.test?", options: [
    { label: "Send once", description: "Send this exact reply." }, { label: "Do not send", description: "Leave it unsent." },
  ] }],
};

test("shows real tool arguments, selects nothing, and submits only an explicit choice", async () => {
  const sent: NativeApprovalSubmission[] = [];
  const ui = render(<NativeApprovalPrompt view={view} onRespond={async (input) => { sent.push(input); }} />);
  expect(ui.getByText(/The exact reviewed reply/).textContent).toContain("reader@example.test");
  const submit = ui.getByRole("button", { name: "Send confirmation" }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  expect((ui.getByRole("radio", { name: /^Send once/ }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(ui.getByRole("radio", { name: /^Send once/ }));
  expect(sent).toEqual([]);
  fireEvent.click(submit);
  await waitFor(() => expect(sent).toEqual([{ requestDigest: "exact-request", decision: "respond", answers: { consent: "Send once" } }]));
});

test("cancel sends no answers and connection loss disables confirmation", async () => {
  const sent: NativeApprovalSubmission[] = [];
  const ui = render(<NativeApprovalPrompt view={view} unavailable onRespond={async (input) => { sent.push(input); }} />);
  expect((ui.getByRole("button", { name: "Send confirmation" }) as HTMLButtonElement).disabled).toBe(true);
  expect(ui.getByRole("alert").textContent).toContain("Connection lost");
  ui.rerender(<NativeApprovalPrompt view={view} onRespond={async (input) => { sent.push(input); }} />);
  fireEvent.click(ui.getByRole("button", { name: "Cancel request" }));
  await waitFor(() => expect(sent).toEqual([{ requestDigest: "exact-request", decision: "cancel" }]));
});
