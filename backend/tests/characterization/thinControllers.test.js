const fs = require('fs');
const path = require('path');
const { cleanupTestDb } = require('../setup');

afterAll(() => cleanupTestDb());

// Guard rail for restructure stage R2 ("thin controllers").
//
// A controller parses input, calls a service and formats the response. It never touches the database: no db.prepare,
// db.exec or db.transaction, and it does not even import the db handle. SQL belongs in services/. If a controller
// needs data, add a function to the matching service.

const CONTROLLERS = path.join(__dirname, '..', '..', 'src', 'controllers');
const DB_USE = /\bdb\s*\.\s*(prepare|exec|transaction|pragma)\b/;
const DB_IMPORT = /require\(\s*['"]\.\.\/config\/db['"]\s*\)/;

const files = fs.readdirSync(CONTROLLERS).filter((f) => f.endsWith('.js')).sort();

describe('controllers stay thin', () => {
  it('finds the controllers', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('no controller runs SQL', () => {
    const offenders = files.filter((f) => DB_USE.test(fs.readFileSync(path.join(CONTROLLERS, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('no controller imports the db handle', () => {
    const offenders = files.filter((f) => DB_IMPORT.test(fs.readFileSync(path.join(CONTROLLERS, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
