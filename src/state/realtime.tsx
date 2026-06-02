import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

type FeedRealtimeContextValue = {
  state: ConnectionState;
  attempt: number;
};

const FeedRealtimeContext = createContext<FeedRealtimeContextValue>({
  state: "offline",
  attempt: 0,
});

function websocketUrl(feedId: string) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/events/ws?feed=${encodeURIComponent(feedId)}`;
}

function reconnectDelay(attempt: number) {
  const base = Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 15_000);
  return base + Math.floor(Math.random() * 300);
}

export function FeedRealtimeProvider({
  feedId,
  enabled,
  onChange,
  children,
}: {
  feedId: string;
  enabled: boolean;
  onChange: () => void;
  children: ReactNode;
}) {
  const [state, setState] = useState<ConnectionState>(enabled ? "connecting" : "offline");
  const [attempt, setAttempt] = useState(0);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    if (!enabled) {
      setState("offline");
      setAttempt(0);
      return;
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;

    const clearRetry = () => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const connect = (nextAttempt: number) => {
      clearRetry();
      if (disposed) return;
      setAttempt(nextAttempt);
      setState(nextAttempt === 0 ? "connecting" : "reconnecting");

      socket = new WebSocket(websocketUrl(feedId));
      socket.addEventListener("open", () => {
        if (disposed) return;
        setAttempt(0);
        setState("live");
      });
      socket.addEventListener("message", () => {
        onChangeRef.current();
      });
      socket.addEventListener("error", () => {
        socket?.close();
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        const retryAttempt = nextAttempt + 1;
        setAttempt(retryAttempt);
        setState("reconnecting");
        retryTimer = window.setTimeout(() => connect(retryAttempt), reconnectDelay(retryAttempt));
      });
    };

    connect(0);

    return () => {
      disposed = true;
      clearRetry();
      socket?.close();
    };
  }, [enabled, feedId]);

  const value = useMemo(() => ({ state, attempt }), [state, attempt]);
  return <FeedRealtimeContext.Provider value={value}>{children}</FeedRealtimeContext.Provider>;
}

export function useFeedRealtime() {
  return useContext(FeedRealtimeContext);
}
