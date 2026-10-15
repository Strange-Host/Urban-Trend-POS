// For dropdowns and pickers that need EVERY row (every product, every active staff member),
// not one screenful. The API caps a page at 100, so asking for { pageSize: 200 } silently
// returned only 100 - a product beyond the 100th simply never appeared in the picker. This
// walks all the pages instead. `maxPages` is a safety stop (default 50 pages = 5,000 rows).
export async function fetchAll(listFn, params = {}, { pageSize = 100, maxPages = 50 } = {}) {
  const rows = [];
  let page = 1;
  let totalPages = 1;
  do {
    const body = (await listFn({ ...params, page, limit: pageSize, pageSize })).data;
    rows.push(...(body.data || []));
    totalPages = body.totalPages || 1;
    page += 1;
  } while (page <= totalPages && page <= maxPages);
  return rows;
}
