globalThis.crypto = require('crypto').webcrypto;
(async()=>{
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.makeWASocket || baileys.default?.makeWASocket;
  const { useMultiFileAuthState, DisconnectReason } = baileys;
  console.log('baileys version', require('@whiskeysockets/baileys/package.json').version);
  console.log('makeWASocket', typeof makeWASocket);
  const { state, saveCreds } = await useMultiFileAuthState('C:\\Users\\39712\\AppData\\Local\\Temp\\opencode\\baileys-test2');
  console.log('auth ok');
  const sock = makeWASocket({ auth: state, printQRInTerminal: true, browser: ['Test','Chrome','1.0'] });
  console.log('sock created');
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', u=>{ console.log('update', JSON.stringify(u).slice(0,1200)); if(u.qr) console.log('QR len', u.qr.length); if(u.connection) console.log('connection', u.connection); });
  setTimeout(()=>{console.log('timeout'); process.exit(0);}, 30000);
})();