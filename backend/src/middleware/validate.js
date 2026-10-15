const ApiError = require('../utils/ApiError');

// Validates req.body against a zod schema before the handler runs, on the
// money-touching endpoints where a malformed payload previously meant
// several lines of hand-written `if (!x) throw` checks per controller —
// zod schemas describe the whole shape in one place and give consistent
// error messages. Deliberately NOT used for checks that need the database
// (e.g. "does this category_id actually exist") — those stay in the
// controller, since zod only knows about the shape of the request, not
// what's true in the database.
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; ');
      throw new ApiError(400, message);
    }
    req.body = result.data;
    next();
  };
}

module.exports = validate;
