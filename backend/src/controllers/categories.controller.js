const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');
const { logStaffAction } = require('../utils/auditLog');

// Categories can be removed two ways:
//   Archive - hides it from the pickers (new products can't be put in it) but keeps it on everything already filed
//             under it, so old reports read the same. Reversible with Restore.
//   Delete  - gone for good. If anything still uses it, the caller says which category to move that to first
//             (products, even switched-off ones, items waiting in the sync review, sub-categories), and it all
//             happens in one step.

// GET /api/categories?include_archived=1
const list = asyncHandler(async (req, res) => {
  const all = req.query.include_archived === '1' || req.query.include_archived === 'true';
  const rows = db.prepare(`SELECT * FROM categories ${all ? '' : 'WHERE is_archived = 0'} ORDER BY name ASC`).all();
  res.json({ data: rows });
});

const create = asyncHandler(async (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !String(name).trim()) throw new ApiError(400, 'name is required.');
  const result = db.prepare('INSERT INTO categories (name, parent_id) VALUES (?, ?)').run(String(name).trim(), parent_id || null);
  res.status(201).json({ data: { id: result.lastInsertRowid, name: String(name).trim(), parent_id: parent_id || null } });
});

const update = asyncHandler(async (req, res) => {
  const { name, parent_id } = req.body;
  if (parent_id && Number(parent_id) === Number(req.params.id)) throw new ApiError(400, 'A category cannot be inside itself.');
  const result = db.prepare('UPDATE categories SET name = ?, parent_id = ? WHERE id = ?')
    .run(name, parent_id || null, req.params.id);
  if (result.changes === 0) throw new ApiError(404, 'Category not found.');
  res.json({ data: { id: Number(req.params.id), name, parent_id: parent_id || null } });
});

// Everything that points at a category, found from the database itself so a table added later is covered too.
function referencesTo(categoryId) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all();
  const found = [];
  for (const { name } of tables) {
    for (const fk of db.pragma(`foreign_key_list(${name})`)) {
      if (fk.table !== 'categories') continue;
      const { c } = db.prepare(`SELECT COUNT(*) AS c FROM "${name}" WHERE "${fk.from}" = ?`).get(categoryId);
      if (c > 0) found.push({ table: name, column: fk.from, count: c });
    }
  }
  return found;
}

function usageOf(category) {
  const refs = referencesTo(category.id);
  const count = (table, column) => refs.find((r) => r.table === table && r.column === column)?.count || 0;
  const products = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id = ?').get(category.id).c;
  const activeProducts = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id = ? AND is_active = 1').get(category.id).c;
  const usage = {
    id: category.id, name: category.name, archived: !!category.is_archived,
    products, activeProducts, inactiveProducts: products - activeProducts,
    staged: count('shopify_staging_products', 'category_id'),
    subcategories: count('categories', 'parent_id'),
  };
  // anything else that points here (a future table)
  usage.other = refs.filter((r) => !(r.table === 'products' || (r.table === 'shopify_staging_products' && r.column === 'category_id') || (r.table === 'categories' && r.column === 'parent_id'))).reduce((n, r) => n + r.count, 0);
  usage.inUse = usage.products + usage.staged + usage.subcategories + usage.other > 0;
  return usage;
}

// GET /api/categories/:id/usage - what would be affected by deleting this category
const usage = asyncHandler(async (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!category) throw new ApiError(404, 'Category not found.');
  res.json({ data: usageOf(category) });
});

// DELETE /api/categories/:id?move_to=<category id>
const remove = asyncHandler(async (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!category) throw new ApiError(404, 'Category not found.');
  const use = usageOf(category);

  const moveTo = req.query.move_to ? Number(req.query.move_to) : null;
  if (use.inUse && !moveTo) {
    throw new ApiError(409, 'This category is still in use. Choose where to move its products, or archive it instead.', use, 'CATEGORY_IN_USE');
  }
  let target = null;
  if (moveTo) {
    if (moveTo === category.id) throw new ApiError(400, 'Choose a different category to move things into.');
    target = db.prepare('SELECT * FROM categories WHERE id = ?').get(moveTo);
    if (!target) throw new ApiError(404, 'The category to move things into was not found.');
    if (target.is_archived) throw new ApiError(400, 'Choose a category that is not archived.');
  }

  const result = db.transaction(() => {
    const moved = { products: 0, staged: 0, other: 0 };
    for (const ref of referencesTo(category.id)) {
      if (ref.table === 'categories' && ref.column === 'parent_id') {
        // sub-categories move up one level, into the deleted category's own parent
        db.prepare('UPDATE categories SET parent_id = ? WHERE parent_id = ?').run(category.parent_id || null, category.id);
      } else {
        const info = db.prepare(`UPDATE "${ref.table}" SET "${ref.column}" = ? WHERE "${ref.column}" = ?`).run(target.id, category.id);
        if (ref.table === 'products') moved.products += info.changes;
        else if (ref.table === 'shopify_staging_products') moved.staged += info.changes;
        else moved.other += info.changes;
      }
    }
    db.prepare('DELETE FROM categories WHERE id = ?').run(category.id);
    logStaffAction({ staffId: req.user.id, action: 'delete', entityType: 'category', entityId: category.id, before: { name: category.name, moved_to: target?.name || null } });
    return moved;
  })();

  res.json({ data: { deleted: true, movedTo: target ? { id: target.id, name: target.name } : null, moved: result, subcategoriesMovedUp: use.subcategories } });
});

// POST /api/categories/:id/archive   and   POST /api/categories/:id/restore
const setArchived = (archived) => asyncHandler(async (req, res) => {
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(req.params.id);
  if (!category) throw new ApiError(404, 'Category not found.');
  db.prepare(`UPDATE categories SET is_archived = ?, archived_at = ${archived ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(archived ? 1 : 0, category.id);
  logStaffAction({ staffId: req.user.id, action: 'update', entityType: 'category', entityId: category.id, before: { is_archived: category.is_archived }, after: { is_archived: archived ? 1 : 0 } });
  res.json({ data: db.prepare('SELECT * FROM categories WHERE id = ?').get(category.id) });
});

module.exports = { list, create, update, remove, usage, archive: setArchived(true), restore: setArchived(false) };
