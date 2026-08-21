const sharp = require('sharp');
const { imagesToIco } = require('png-to-ico');
const fs = require('fs');

const svg = `<svg width="256" height="256" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
<circle cx="100" cy="100" r="95" fill="#0093E0"/>
<ellipse cx="100" cy="115" rx="70" ry="62" fill="#FFFFFF"/>
<ellipse cx="72" cy="78" rx="24" ry="28" fill="#FFFFFF" stroke="#333" stroke-width="2"/>
<ellipse cx="128" cy="78" rx="24" ry="28" fill="#FFFFFF" stroke="#333" stroke-width="2"/>
<circle cx="78" cy="80" r="8" fill="#333"/>
<circle cx="122" cy="80" r="8" fill="#333"/>
<circle cx="100" cy="105" r="10" fill="#E60012"/>
<line x1="100" y1="115" x2="100" y2="145" stroke="#333" stroke-width="2"/>
<path d="M65 140 Q100 170 135 140" fill="none" stroke="#333" stroke-width="3" stroke-linecap="round"/>
<line x1="25" y1="100" x2="65" y2="110" stroke="#333" stroke-width="2"/>
<line x1="25" y1="115" x2="65" y2="118" stroke="#333" stroke-width="2"/>
<line x1="25" y1="130" x2="65" y2="126" stroke="#333" stroke-width="2"/>
<line x1="175" y1="100" x2="135" y2="110" stroke="#333" stroke-width="2"/>
<line x1="175" y1="115" x2="135" y2="118" stroke="#333" stroke-width="2"/>
<line x1="175" y1="130" x2="135" y2="126" stroke="#333" stroke-width="2"/>
<rect x="55" y="170" width="90" height="12" rx="6" fill="#E60012"/>
<circle cx="100" cy="180" r="10" fill="#FFD700" stroke="#DAA520" stroke-width="1.5"/>
<line x1="92" y1="180" x2="108" y2="180" stroke="#DAA520" stroke-width="1.5"/>
<circle cx="100" cy="175" r="2" fill="#DAA520"/>
</svg>`;

async function main() {
  const sizes = [16, 32, 48, 64, 128, 256];
  for (const s of sizes) {
    const png = await sharp(Buffer.from(svg)).resize(s, s).png().toBuffer();
    fs.writeFileSync('resources/doraemon-' + s + '.png', png);
  }
  // Build ICO manually (simple format)
  const pngs = sizes.map(s => fs.readFileSync('resources/doraemon-' + s + '.png'));
  const icoHeader = Buffer.alloc(6);
  icoHeader.writeUInt16LE(0, 0);     // reserved
  icoHeader.writeUInt16LE(1, 2);     // type: icon
  icoHeader.writeUInt16LE(sizes.length, 4); // count

  let dataOffset = 6 + sizes.length * 16;
  const entries = [];
  for (let i = 0; i < sizes.length; i++) {
    const s = sizes[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(s === 256 ? 0 : s, 0);  // width
    entry.writeUInt8(s === 256 ? 0 : s, 1);  // height
    entry.writeUInt8(0, 2);    // colors
    entry.writeUInt8(0, 3);    // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(pngs[i].length, 8); // size
    entry.writeUInt32LE(dataOffset, 12); // offset
    entries.push(entry);
    dataOffset += pngs[i].length;
  }

  const ico = Buffer.concat([icoHeader, ...entries, ...pngs]);
  fs.writeFileSync('resources/employee-icon.ico', ico);
  fs.writeFileSync('resources/employee-icon.png', fs.readFileSync('resources/doraemon-256.png'));
  fs.writeFileSync('resources/employee-tray.png', fs.readFileSync('resources/doraemon-16.png'));
  console.log('ICO: ' + (ico.length / 1024).toFixed(1) + 'KB');
}

main().catch(e => console.error(e));
