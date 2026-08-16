export interface PaginationInput {
  page?: unknown;
  limit?: unknown;
  sort?: unknown;
  order?: unknown;
}

export interface ResolvedPagination {
  page: number;
  limit: number;
  skip: number;
  sort: Record<string, 1 | -1>;
}

const MAX_LIMIT = 200;

export function resolvePagination(
  query: PaginationInput,
  defaults: { sort?: string; order?: 'asc' | 'desc'; limit?: number } = {},
): ResolvedPagination {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const rawLimit = Number.parseInt(String(query.limit ?? defaults.limit ?? 25), 10) || 25;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));

  const sortField = String(query.sort ?? defaults.sort ?? 'createdAt').replace(/[^\w.]/g, '');
  const order = String(query.order ?? defaults.order ?? 'desc').toLowerCase() === 'asc' ? 1 : -1;

  return {
    page,
    limit,
    skip: (page - 1) * limit,
    sort: { [sortField || 'createdAt']: order as 1 | -1 },
  };
}

/** Escapes user input before it reaches a MongoDB $regex query. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
