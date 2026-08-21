const initSqlJs = require('sql.js');
const fs = require('fs');

async function main() {
  const SQL = await initSqlJs();
  const dbPath = 'C:\\Users\\39712\\AppData\\Roaming\\whatsapp-employee-client\\database\\accounts.db';
  if (!fs.existsSync(dbPath)) { console.log('employee DB not found'); return; }
  const db = new SQL.Database(fs.readFileSync(dbPath));

  // List all tables
  const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table'");
  console.log('tables:', tables[0] ? tables[0].values.map(r => r[0]).join(', ') : 'none');

  // Check accounts table
  const schema = db.exec("SELECT sql FROM sqlite_master WHERE name='accounts'");
  if (schema[0]) console.log('accounts schema:', schema[0].values[0][0]);

  const accounts = db.exec('SELECT id, phone, name, assigned_to, status FROM accounts');
  if (accounts[0]) {
    console.log('accounts (' + accounts[0].values.length + '):');
    for (const r of accounts[0].values) {
      console.log(r[0] + ' | ' + r[1] + ' | ' + r[2] + ' | assigned:' + (r[3] || 'none') + ' | ' + r[4]);
    }
  } else {
    console.log('no accounts in employee DB');
  }

  // Check employees table
  const employees = db.exec('SELECT id, username, name FROM employees');
  if (employees[0]) {
    console.log('employees:');
    for (const r of employees[0].values) {
      console.log(r[0] + ' | ' + r[1] + ' | ' + r[2]);
    }
  }

  // Check settings
  const settings = db.exec('SELECT * FROM settings');
  if (settings[0]) {
    console.log('settings:');
    for (const r of settings[0].values) {
      console.log(r.join(' | '));
    }
  } else {
    console.log('no settings table');
  }

  db.close();
}

main().catch(e => console.error(e));
