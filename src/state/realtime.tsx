import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

type RealtimeContextValue = {
  state: ConnectionState;
  reconnects: number;
};

const RealtimeContext = createContext<RealtimeContextValue>({ state: "offline", reconnects: 0 });

export function RealtimeProvider({
  enabled,
  onChange,
  children,
}: {
  enabled: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  const [state, setState] = useState<ConnectionState>(enabled ? "connecting" : "offline");
  const [reconnects, setReconnects] = useState(0);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled) {
      setState("offline");
      setReconnects(0);
      return;
    }

    let disposed = false;
    const events = new EventSource("/api/events");
    setState((current) => current === "offline" ? "connecting" : "reconnecting");

    events.addEventListener("ready", () => {
      if (disposed) return;
      setState("live");
    });
    events.addEventListener("change", () => {
      if (disposed) return;
      setState("live");
      onChangeRef.current();
    });
    events.onerror = () => {
      if (disposed) return;
      setState("reconnecting");
      setReconnects((current) => current + 1);
    };

    return () => {
      disposed = true;
      events.close();
    };
  }, [enabled]);

  const value = useMemo(() => ({ state, reconnects }), [state, reconnects]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  return useContext(RealtimeContext);
}
