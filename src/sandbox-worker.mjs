// Runs only inside the disposable Docker container. Docker provides isolation;
// node:vm provides a persistent namespace, NOT a security boundary.
import { chromium } from 'playwright';
import { createInterface } from 'node:readline';
import { createContext, runInContext } from 'node:vm';
import { format } from 'node:util';
import { readFile } from 'node:fs/promises';

let browser, context, page, namespace;
let output = [];
let outputBytes = 0;
const maxOutputBytes = 12 * 1024 * 1024;

function emit(item) {
  outputBytes += Buffer.byteLength(JSON.stringify(item));
  if (outputBytes > maxOutputBytes) throw new Error('Script output exceeded 12 MiB.');
  output.push(item);
}

function display(value) {
  const data = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value).toString('base64') : value;
  if (typeof data !== 'string') throw new Error('display() expects PNG bytes or base64.');
  const base64 = data.replace(/^data:image\/png;base64,/, '');
  if (!base64.startsWith('iVBORw0KGgo')) throw new Error('display() expects a PNG image.');
  emit({ type: 'image', image: 'data:image/png;base64,' + base64, detail: 'original' });
}

async function handle(message) {
  switch (message.method) {
    case 'init': {
      browser = await chromium.launch({ headless: true, env: {} });
      context = await browser.newContext({
        viewport: message.viewport, deviceScaleFactor: 1, acceptDownloads: false,
        serviceWorkers: 'block',
      });
      context.setDefaultTimeout(5_000);
      context.setDefaultNavigationTimeout(30_000);
      await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      page = await context.newPage();
      namespace = createContext({
        browser, context, page, Buffer,
        console: { log: (...args) => emit({ type: 'text', text: format(...args).slice(0, 16_000) }) },
        display,
      });
      return true;
    }
    case 'open': {
      const target = new URL(message.url);
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Use an HTTP(S) URL.');
      // Offline fixtures intercept all requests and run with Docker networking disabled.
      if (message.html !== undefined) {
        await context.route('**/*', (route) => route.request().url() === message.url
          ? route.fulfill({ contentType: 'text/html', body: message.html }) : route.abort());
      }
      await page.goto(message.url);
      return true;
    }
    case 'execute': {
      if (typeof message.code !== 'string' || !message.code.trim() || message.code.length > 50_000) {
        throw new Error('Provide 1–50,000 characters of JavaScript.');
      }
      output = [];
      outputBytes = 0;
      let error;
      try {
        // Top-level await works inside the wrapper; reusable state lives on globalThis.
        await runInContext('(async () => {\n' + message.code + '\n})()', namespace, {
          timeout: 1_000, filename: 'agent-script.js',
        });
      } catch (failure) {
        error = String(failure.message ?? failure).slice(0, 4_000);
      }
      // Always show the final UI, including after partial execution or script errors.
      if (outputBytes > maxOutputBytes - 4 * 1024 * 1024) { output = []; outputBytes = 0; }
      display(await page.screenshot({ type: 'png', scale: 'css' }));
      if (error) emit({ type: 'text', text: 'Script error: ' + error });
      return { output, error };
    }
    case 'screenshot':
      return (await page.screenshot({ type: 'png', scale: 'css', fullPage: message.fullPage ?? false }))
        .toString('base64');
    case 'trace':
      await context.tracing.stop({ path: '/tmp/trace.zip' });
      return (await readFile('/tmp/trace.zip')).toString('base64');
    default:
      throw new Error('Unknown runtime method.');
  }
}

// Commands are serialized so scripts cannot race for the browser or output buffer.
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  let message;
  try {
    message = JSON.parse(line);
    const result = await handle(message);
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id: message?.id, error: String(error.message ?? error) }) + '\n');
  }
}
await browser?.close();
