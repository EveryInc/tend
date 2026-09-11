import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, render } from "@testing-library/react";
import { RealtimeProvider } from "../src/state/realtime";

GlobalRegistrator.register();

class StubEventSource {
  static instance: StubEventSource;
  onerror: (() => void) | null = null;
  listeners = new Map<string, () => void>();
  constructor() { StubEventSource.instance = this; }
  addEventListener(name: string, listener: () => void) { this.listeners.set(name, listener); }
  close() {}
  emit(name: string) { this.listeners.get(name)?.(); }
}

Object.assign(globalThis, { EventSource: StubEventSource });

test("a reconnect ready event refreshes state missed while offline", async () => {
  let changes = 0;
  render(<RealtimeProvider enabled onChange={() => { changes += 1; }}><div>child</div></RealtimeProvider>);

  await act(async () => StubEventSource.instance.emit("ready"));
  await act(async () => StubEventSource.instance.onerror?.());
  await act(async () => StubEventSource.instance.emit("ready"));

  expect(changes).toBe(1);
});

test("recovery after an initial connection failure refreshes state", async () => {
  let changes = 0;
  render(<RealtimeProvider enabled onChange={() => { changes += 1; }}><div>child</div></RealtimeProvider>);
  await act(async () => StubEventSource.instance.onerror?.());
  await act(async () => StubEventSource.instance.emit("ready"));
  expect(changes).toBe(1);
});
