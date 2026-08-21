const initSqlJs = require('sql.js');
const fs = require('fs');

async function main() {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync('C:\\Users\\39712\\AppData\\Roaming\\whatsapp-account-manager\\database\\accounts.db');
  const db = new SQL.Database(buf);

  // List tables
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  console.log('tables:', tables[0].values.map(r => r[0]));

  // Employees
  try {
    const emps = db.exec('SELECT id, username, name FROM employees');
    console.log('\nemployees:', emps[0] ? emps[0].values : []);
  } catch (e) { console.log('no employees table'); }

  // Accounts
  try {
    const total = db.exec('SELECT COUNT(*) FROM accounts');
    console.log('\ntotal accounts:', total[0].values[0][0]);

    const assigned = db.exec('SELECT COUNT(*) FROM accounts WHERE assigned_to IS NOT NULL');
    console.log('assigned:', assigned[0].values[0][0]);

    const unassigned = db.exec('SELECT id, phone, name FROM accounts WHERE assigned_to IS NULL');
    console.log('unassigned count:', unassigned[0] ? unassigned[0].values.length : 0);
    if (unassigned[0]) {
      console.log('sample unassigned:', unassigned[0].values.slice(0, 3));
    }
  } catch (e) { console.log('accounts error:', e.message); }

  db.close();
}

main().catch(e => console.error(e));
