const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '..', 'public');
const svgPath = path.join(publicDir, 'logo.svg');

async function generateIcons() {
  console.log('Reading logo.svg...');

  if (!fs.existsSync(svgPath)) {
    console.error('Error: logo.svg not found at', svgPath);
    process.exit(1);
  }

  const svgBuffer = fs.readFileSync(svgPath);
  console.log('SVG loaded, generating icons...\n');

  const sizes = [
    { name: 'icon-192.png', size: 192 },
    { name: 'icon-512.png', size: 512 },
    { name: 'apple-touch-icon.png', size: 180 },
    { name: 'favicon-32.png', size: 32 },
    { name: 'favicon-16.png', size: 16 },
  ];

  for (const { name, size } of sizes) {
    const outputPath = path.join(publicDir, name);
    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);
    console.log(`✓ Generated ${name} (${size}x${size})`);
  }

  // Generate ICO file (using the 32px PNG as base)
  // Sharp doesn't support ICO directly, so we'll use the 32px PNG
  // For a proper favicon.ico, we'd need another library, but browsers support PNG favicons
  const favicon32Path = path.join(publicDir, 'favicon-32.png');
  const faviconPath = path.join(publicDir, 'favicon.ico');

  // Copy 32px as favicon (modern browsers support PNG)
  fs.copyFileSync(favicon32Path, faviconPath);
  console.log('✓ Generated favicon.ico (copied from 32px PNG)');

  console.log('\n✅ All icons generated successfully!');
  console.log('\nGenerated files:');

  const files = ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-32.png', 'favicon-16.png', 'favicon.ico'];
  for (const file of files) {
    const filePath = path.join(publicDir, file);
    const stats = fs.statSync(filePath);
    console.log(`  - ${file} (${stats.size} bytes)`);
  }
}

generateIcons().catch(err => {
  console.error('Error generating icons:', err);
  process.exit(1);
});
