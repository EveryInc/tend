export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? `Request failed: ${response.status}`);
  return value as T;
}

export function post<T>(url: string, value: unknown = {}): Promise<T> {
  return api<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
}
