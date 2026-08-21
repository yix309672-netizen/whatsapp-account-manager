const initSqlJs = require('sql.js');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

async function main() {
  const SQL = await initSqlJs();
  const dbPath = 'C:\\Users\\39712\\AppData\\Roaming\\whatsapp-account-manager\\database\\accounts.db';
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  // Check schema
  const schema = db.exec("SELECT sql FROM sqlite_master WHERE name='accounts'");
  console.log('schema:', schema[0].values[0][0]);

  const cols = db.exec("PRAGMA table_info(accounts)");
  console.log('columns:', cols[0].values.map(r => r[1]));

  db.close();
}

main().catch(e => console.error(e));
