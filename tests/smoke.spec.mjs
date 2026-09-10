import { test, expect } from './fixtures.mjs';
import { Usage, OpenAIResponsesModel } from '@openai/agents';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBrowserAgent, runBrowserTask } from '../src/browser-agent.mjs';

const execFileAsync = promisify(execFile);
const url = 'https://forms.example.test/contact/';
const fields = { Name: 'Alex Taylor', Email: 'alex.taylor@example.com', Message: 'Test inquiry.' };
const successText = 'Thanks! Your message has been received.';
const html = `<!doctype html><html lang="en"><title>Demo contact form</title>
  <form>
    <label>Name <input name="name" required></label>
    <label>Email <input name="email" type="email" required></label>
    <label>Message <textarea name="message" required></textarea></label>
    <button type="submit">Send message</button>
  </form>
  <p role="status"></p>
  <script>
    document.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      document.querySelector('[role="status"]').textContent = 'Thanks! Your message has been received.';
      event.target.reset();
    });
  </script></html>`;

// No API key or outbound network is needed after building the runtime image.
test.use({ runtimeOffline: true });
test.beforeEach(async ({ runtime }) => { await runtime.open(url, html); });

function textOutput(output) {
  return output.filter((item) => ['text', 'input_text'].includes(item.type)).map((item) => item.text).join('\n');
}

function expectScreenshot(output) {
  const screenshot = output.findLast((item) => ['image', 'input_image'].includes(item.type));
  expect(screenshot?.image).toMatch(/^data:image\/png;base64,iVBOR/);
  expect(screenshot.detail).toBe('original');
}

test('exec_js fills and submits a form through the SDK with persistent state and images', async ({ runtime }) => {
  const scripts = [
    `globalThis.fields = ${JSON.stringify(fields)};
     globalThis.status = page.getByRole('status');
     for (const [name, value] of Object.entries(fields)) {
       await page.getByRole('textbox', { name, exact: true }).fill(value);
     }
     console.log(JSON.stringify(await page.locator('input, textarea').evaluateAll(nodes => nodes.map(n => n.value))));
     display(await page.screenshot());`,
    `if ((await status.innerText()) !== '') throw new Error('Submitted too soon.');
     if (await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue() !== fields.Name) {
       throw new Error('Form state was lost.');
     }
     await page.getByRole('button', { name: 'Send message' }).click();
     console.log(await status.innerText());`,
  ];
  let turn = 0;
  const model = {
    async getResponse(request) {
      expect(request.tools.map(({ name }) => name)).toEqual(['web_search', 'exec_js']);
      expect(request.tools.find(({ name }) => name === 'exec_js').type).toBe('function');
      if (turn === 0) {
        const initial = request.input.find((item) => item.role === 'user');
        expectScreenshot(initial.content);
      } else {
        const result = request.input.findLast((item) => item.type === 'function_call_result');
        expect(result.callId).toBe('call-' + turn);
        expectScreenshot(result.output);
        expect(textOutput(result.output)).not.toContain('Script error:');
        if (turn === 1) expect(JSON.parse(textOutput(result.output))).toEqual(Object.values(fields));
        if (turn === 2) expect(textOutput(result.output)).toBe(successText);
      }
      const code = scripts[turn++];
      return {
        usage: new Usage(),
        output: code
          ? [{ type: 'function_call', name: 'exec_js', callId: 'call-' + turn,
            arguments: JSON.stringify({ code }), status: 'completed' }]
          : [{ type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Done.' }] }],
      };
    },
    async *getStreamedResponse() { throw new Error('Streaming is not used in this test.'); },
  };
  const result = await runBrowserTask(runtime, 'Fill and submit this pretend form.', { model });
  expect(result.finalOutput).toBe('Done.');
  expect(turn).toBe(3);
  expect(runtime.history.every((entry) => !entry.error)).toBe(true);
  const final = await runtime.execute("console.log(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue());");
  expect(textOutput(final)).toBe('');
});

test('script errors return the current screen and allow a corrected call', async ({ runtime }) => {
  const failed = await runtime.execute("await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Before error'); throw new Error('Try again');");
  expect(textOutput(failed)).toContain('Script error: Try again');
  expectScreenshot(failed);
  const corrected = await runtime.execute("console.log(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue());");
  expect(textOutput(corrected)).toBe('Before error');
  expectScreenshot(corrected);
});

test('runtime has no host mounts or API credentials and uses a read-only filesystem', async ({ runtime }) => {
  const { stdout } = await execFileAsync('docker', ['inspect', runtime.name]);
  const [container] = JSON.parse(stdout);
  expect(container.Mounts).toEqual([]);
  expect(container.HostConfig.ReadonlyRootfs).toBe(true);
  expect(container.Config.User).toBe('pwuser');
  expect(container.Config.Env.some((entry) => entry.startsWith('OPENAI_API_KEY='))).toBe(false);
  expect(container.HostConfig.NetworkMode).toBe('none');
  const result = await execFileAsync('docker', ['exec', runtime.name, 'node', '-e',
    "const fs = require('node:fs'); console.log(fs.existsSync('/app/.env')); try { fs.writeFileSync('/app/probe', 'x'); } catch (e) { console.log(e.code); }",
  ]);
  expect(result.stdout.trim().split('\n')).toEqual(['false', 'EROFS']);
});

test('a hung async script is killed and its container removed', async ({ runtime }) => {
  runtime.executionTimeout = 500;
  await expect(runtime.execute('await Promise.resolve(); while (true) {}')).rejects.toThrow('timed out');
  await runtime.close();
  await expect(execFileAsync('docker', ['inspect', runtime.name])).rejects.toThrow();
  await expect(runtime.execute('console.log("still running")')).rejects.toThrow('timed out');
});

test('cancelling the SDK run stops pending code and removes the container', async ({ runtime }) => {
  const controller = new AbortController();
  const model = {
    async getResponse() {
      setTimeout(() => controller.abort(new Error('Cancelled by test')), 250);
      return {
        usage: new Usage(), output: [{ type: 'function_call', name: 'exec_js', callId: 'cancel-call',
          arguments: JSON.stringify({ code: 'await new Promise(() => {});' }), status: 'completed' }],
      };
    },
    async *getStreamedResponse() { throw new Error('Streaming is not used in this test.'); },
  };
  await expect(runBrowserTask(runtime, 'Inspect the form.', { model, signal: controller.signal })).rejects.toThrow();
  await runtime.close();
  await expect(execFileAsync('docker', ['inspect', runtime.name])).rejects.toThrow();
});

test('trace capture returns an inspectable ZIP', async ({ runtime }) => {
  await runtime.execute("await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Trace check');");
  const trace = await runtime.trace();
  expect(trace.subarray(0, 2).toString()).toBe('PK');
});

test('agent defaults to Astra and preserves an explicit model override', async ({ runtime }) => {
  const previousModel = process.env.OPENAI_MODEL;
  try {
    delete process.env.OPENAI_MODEL;
    expect(createBrowserAgent(runtime).model).toBe('gpt-6-astra');
    process.env.OPENAI_MODEL = 'custom-model';
    expect(createBrowserAgent(runtime).model).toBe('custom-model');
    expect(createBrowserAgent(runtime, 'explicit-model').model).toBe('explicit-model');
  } finally {
    if (previousModel === undefined) delete process.env.OPENAI_MODEL;
    else process.env.OPENAI_MODEL = previousModel;
  }
});


test('Responses API adapter serializes exec_js and original-resolution image results', async ({ runtime }) => {
  let calls = 0;
  // This client has no transport: the real SDK adapter serializes requests, and
  // this in-memory stub supplies the API responses. Nothing leaves the machine.
  const client = {
    responses: {
      async create(body) {
        expect(body.model).toBe('gpt-6-astra');
        expect(body.reasoning.effort).toBe('low');
        expect(body.parallel_tool_calls).toBe(false);
        expect(body.tools.map((item) => item.type)).toEqual(['web_search', 'function']);
        expect(body.tools[1].name).toBe('exec_js');
        if (calls++ === 0) {
          const user = body.input.find((item) => item.role === 'user');
          expect(user.content.find((item) => item.type === 'input_image').detail).toBe('original');
          return {
            id: 'resp_1', status: 'completed', output: [{
              id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'exec_js',
              arguments: JSON.stringify({ code: 'console.log(await page.title());' }),
              status: 'completed',
            }],
          };
        }
        const result = body.input.findLast((item) => item.type === 'function_call_output');
        expect(result.call_id).toBe('call_1');
        expect(result.output.find((item) => item.type === 'input_text').text).toBe('Demo contact form');
        const screenshot = result.output.find((item) => item.type === 'input_image');
        expect(screenshot.image_url).toMatch(/^data:image\/png;base64,iVBOR/);
        expect(screenshot.detail).toBe('original');
        return {
          id: 'resp_2', status: 'completed', output: [{
            id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Inspected.', annotations: [] }],
          }],
        };
      },
    },
  };
  const result = await runBrowserTask(runtime, 'Inspect this form.', {
    model: new OpenAIResponsesModel(client, 'gpt-6-astra'),
  });
  expect(result.finalOutput).toBe('Inspected.');
  expect(calls).toBe(2);
});
