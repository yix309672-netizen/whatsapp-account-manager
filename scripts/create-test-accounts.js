const initSqlJs = require('sql.js');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

async function main() {
  const SQL = await initSqlJs();
  const dbPath = 'C:\\Users\\39712\\AppData\\Roaming\\whatsapp-account-manager\\database\\accounts.db';
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  const emps = db.exec("SELECT id FROM employees WHERE username='小易'");
  const empId = emps[0].values[0][0];
  console.log('employee id:', empId);

  // First unassign existing
  db.run("UPDATE accounts SET assigned_to = NULL");

  // Create 20 test accounts
  const now = Date.now();
  for (let i = 1; i <= 20; i++) {
    const id = uuidv4();
    const phone = '138' + String(10000000 + Math.floor(Math.random() * 90000000));
    const name = '测试账号' + i;
    db.run(
      "INSERT INTO accounts (id, device_id, name, phone, status, created_at, assigned_to) VALUES (?, ?, ?, ?, 'offline', ?, ?)",
      [id, 'test-device', name, phone, now + i * 1000, empId]
    );
  }

  const total = db.exec('SELECT COUNT(*) FROM accounts');
  const assigned = db.exec("SELECT COUNT(*) FROM accounts WHERE assigned_to='" + empId + "'");
  console.log('total:', total[0].values[0][0]);
  console.log('assigned to 小易:', assigned[0].values[0][0]);

  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  console.log('saved');

  db.close();
}

main().catch(e => console.error(e));
