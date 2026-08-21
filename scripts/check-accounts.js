const initSqlJs = require('sql.js');
const fs = require('fs');

async function main() {
  const SQL = await initSqlJs();
  const dbPath = 'C:\\Users\\39712\\AppData\\Roaming\\whatsapp-account-manager\\database\\accounts.db';
  const db = new SQL.Database(fs.readFileSync(dbPath));

  const accounts = db.exec('SELECT id, phone, name, assigned_to FROM accounts');
  if (accounts[0]) {
    console.log('accounts (' + accounts[0].values.length + '):');
    for (const r of accounts[0].values) {
      console.log(r[1] + ' | ' + r[2] + ' | assigned:' + (r[3] || 'none'));
    }
  } else {
    console.log('no accounts');
  }
  db.close();
}

main().catch(e => console.error(e));
