class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

let mutationTokenPromise: Promise<string> | null = null;

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new ApiError(value.error ?? `Request failed: ${response.status}`, response.status);
  return value as T;
}

export async function post<T>(url: string, value: unknown = {}): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const mutationToken = await localMutationToken();
    try {
      return await api<T>(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-attention-mutation-token": mutationToken,
        },
        body: JSON.stringify(value),
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 403 || attempt > 0) throw error;
      mutationTokenPromise = null;
    }
  }
  throw new Error("Local mutation authorization failed.");
}

function localMutationToken(): Promise<string> {
  mutationTokenPromise ??= api<{ mutationToken: string }>("/api/session")
    .then((session) => session.mutationToken)
    .catch((error) => {
      mutationTokenPromise = null;
      throw error;
    });
  return mutationTokenPromise;
}
