import { firefox } from 'playwright';

const browser = await firefox.launch({
  firefoxUserPrefs: {
    'media.navigator.streams.fake': true,
    'media.navigator.permission.disabled': true,
  },
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

const errors = [];
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('pageerror', err => errors.push(`PAGEERROR: ${err.message}`));

await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

async function exerciseGL(modeLabel, glCanvas) {
  // wheel zoom, rotate drag, shift+pan drag, dblclick reset
  const box = await glCanvas.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -300);
  await page.mouse.down();
  await page.mouse.move(cx + 80, cy - 40, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 30, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(300);
  console.log(`${modeLabel}: interactions OK`);
}

async function testMode(tabName, label) {
  await page.getByRole('button', { name: tabName }).first().click();
  await page.waitForTimeout(600);
  const start = page.getByRole('button', { name: /^Start/ }).first();
  if (await start.isVisible().catch(() => false)) await start.click();
  await page.waitForTimeout(2000);

  const select = page.locator('select').filter({ has: page.locator('option[value="terrain"]') }).first();
  const glCanvas = page.locator('canvas').last();

  // default should already be terrain
  const val = await select.inputValue();
  console.log(`${label}: default view = ${val}`);

  await exerciseGL(label, glCanvas);
  await page.screenshot({ path: `/tmp/gl-${label}-terrain.png` });

  await select.selectOption('ridge');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `/tmp/gl-${label}-ridge.png` });
  await select.selectOption('terrain');
  await page.waitForTimeout(300);

  const stop = page.getByRole('button', { name: /^Stop/ }).first();
  if (await stop.isVisible().catch(() => false)) await stop.click();
  await page.waitForTimeout(300);
}

await testMode(/^RTTY/, 'rtty');
await testMode(/^CW/, 'cw');
await testMode(/^SSTV/, 'sstv');
await testMode(/^FT/, 'ft');

const shaderErrors = errors.filter(e => e.includes('GLSpectrogram'));
console.log('console errors:', errors.length ? errors.join('\n---\n') : '(none)');
console.log(shaderErrors.length ? 'SHADER ERRORS FOUND' : 'NO SHADER ERRORS');
await browser.close();
