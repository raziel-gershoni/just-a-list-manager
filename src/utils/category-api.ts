import type { ListCategory } from "@/src/types";

async function call(url: string, jwt: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Category request failed: ${res.status}`);
  return res.json();
}

export async function createCategory(listId: string, jwt: string, name: string, locale: string): Promise<ListCategory> {
  return (await call(`/api/lists/${listId}/categories`, jwt, "POST", { name, locale })).category;
}

export async function renameCategory(listId: string, jwt: string, id: string, name: string, locale: string): Promise<ListCategory> {
  return (await call(`/api/lists/${listId}/categories/${id}`, jwt, "PATCH", { name, locale })).category;
}

export async function deleteCategory(listId: string, jwt: string, id: string): Promise<void> {
  await call(`/api/lists/${listId}/categories/${id}`, jwt, "DELETE");
}

export async function reorderCategories(listId: string, jwt: string, orderedIds: string[]): Promise<void> {
  await call(`/api/lists/${listId}/categories/order`, jwt, "PUT", { orderedIds });
}
