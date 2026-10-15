const db = require('../config/db');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

const list = asyncHandler(async (req, res) => {
  const rows = db.prepare('SELECT * FROM categories ORDER BY name ASC').all();
  res.json({ data: rows });
});

const create = asyncHandler(async (req, res) => {
  const { name, parent_id } = req.body;
  if (!name) throw new ApiError(400, 'name is required.');
  const result = db.prepare('INSERT INTO categories (name, parent_id) VALUES (?, ?)').run(name, parent_id || null);
  res.status(201).json({ data: { id: result.lastInsertRowid, name, parent_id: parent_id || null } });
});

const update = asyncHandler(async (req, res) => {
  const { name, parent_id } = req.body;
  const result = db.prepare('UPDATE categories SET name = ?, parent_id = ? WHERE id = ?')
    .run(name, parent_id || null, req.params.id);
  if (result.changes === 0) throw new ApiError(404, 'Category not found.');
  res.json({ data: { id: Number(req.params.id), name, parent_id: parent_id || null } });
});

const remove = asyncHandler(async (req, res) => {
  const inUse = db.prepare('SELECT COUNT(*) c FROM products WHERE category_id = ? AND is_active = 1').get(req.params.id).c;
  if (inUse > 0) throw new ApiError(409, 'Cannot delete a category with active products. Reassign them first.');
  const result = db.prepare('DELETE FROM categories WHERE id = ?').run(req.params.id);
  if (result.changes === 0) throw new ApiError(404, 'Category not found.');
  res.status(204).send();
});

module.exports = { list, create, update, remove };
