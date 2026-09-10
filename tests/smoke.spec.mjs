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

const nativeHtml = html.replace('</html>', `<script>
  document.modelContext.registerTool({
    name: 'update_contact',
    description: 'Update the name field without submitting the form.',
    inputSchema: {
      type: 'object', properties: { name: { type: 'string' }, note: { type: 'string' } },
      required: ['name'], additionalProperties: false
    },
    execute(input) {
      if (!input.name) throw new Error('A nonempty name is required.');
      document.querySelector('[name="name"]').value = input.name;
      return { updated: true, name: input.name, noteProvided: 'note' in input };
    }
  });
  </script></html>`);

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
  const result = await runBrowserTask(runtime, 'Fill and submit this pretend form.', { model, structuredWebMCP: true });
  expect(runtime.structuredObservations).toBe(false); // No native tools: keep browser observations.
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

test('native WebMCP is exposed through the Responses adapter and updates the visible form', async ({ runtime }) => {
  await runtime.open(url, nativeHtml);
  let calls = 0;
  const client = {
    responses: {
      async create(body) {
        const nativeTool = body.tools.find(item => item.name?.endsWith('_update_contact'));
        expect(nativeTool).toMatchObject({
          type: 'function', strict: false,
          parameters: { type: 'object', required: ['name'], properties: { note: { type: 'string' } } },
        });
        if (calls++ === 0) return {
          id: 'native_1', status: 'completed', output: [{
            id: 'native_fc', type: 'function_call', call_id: 'native_call',
            name: nativeTool.name, arguments: JSON.stringify({ name: 'Alex Taylor' }), status: 'completed',
          }],
        };
        const result = body.input.findLast(item => item.type === 'function_call_output');
        expect(JSON.parse(result.output.find(item => item.type === 'input_text').text)).toEqual({
          updated: true, name: 'Alex Taylor', noteProvided: false,
        });
        expect(result.output.find(item => item.type === 'input_image').detail).toBe('original');
        return {
          id: 'native_2', status: 'completed', output: [{
            id: 'native_msg', type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: 'Updated with WebMCP.', annotations: [] }],
          }],
        };
      },
    },
  };
  const result = await runBrowserTask(runtime, 'Fill in the name without submitting.', {
    model: new OpenAIResponsesModel(client, 'gpt-6-astra'), requiredWebMCPTool: 'update_contact',
  });
  expect(result.finalOutput).toBe('Updated with WebMCP.');
  expect(calls).toBe(2);
  expect(runtime.webmcp).toMatchObject({ status: 'ready', nativeAvailable: true });
  expect(runtime.history).toHaveLength(1);
  expect(runtime.history[0]).toMatchObject({ type: 'webmcp', name: 'update_contact', input: { name: 'Alex Taylor' } });
  expect(runtime.history[0].error).toBeUndefined();
  const visible = await runtime.execute("console.log(await page.locator('[name=name]').inputValue()); console.log(await page.getByRole('status').innerText());");
  expect(textOutput(visible).trim()).toBe('Alex Taylor');
});

test('webmcp=off withholds even site-wide native tools and fails an explicit requirement before a model call', async ({ runtime }) => {
  await runtime.open(url + '?webmcp=off', nativeHtml);
  const model = { getResponse() { throw new Error('The model must not be called.'); } };
  await expect(runBrowserTask(runtime, 'Inspect.', { model, requiredWebMCPTool: 'update_contact', structuredWebMCP: true })).rejects.toThrow('unavailable (disabled)');
  expect(runtime.structuredObservations).toBe(false);
  expect(runtime.webmcp).toMatchObject({ status: 'disabled', nativeAvailable: true, tools: [] });
  expect(createBrowserAgent(runtime).tools.map(tool => tool.name)).toEqual(['web_search', 'exec_js']);
  await expect(runtime.executeWebMCP('update_contact', { name: 'Blocked' })).rejects.toThrow('not exposed');
  const visible = await runtime.execute("console.log(await page.locator('[name=name]').inputValue());");
  expect(textOutput(visible)).toBe('');
});

test('native tool errors return a screenshot, allow correction, and reject calls after page navigation', async ({ runtime }) => {
  await runtime.open(url, nativeHtml);
  await runtime.discoverWebMCP();
  const failed = await runtime.executeWebMCP('update_contact', { name: '' });
  expect(textOutput(failed)).toContain('WebMCP error:');
  expectScreenshot(failed);
  expect(runtime.history[0].error).toBeTruthy();
  const corrected = await runtime.executeWebMCP('update_contact', { name: 'Corrected' });
  expect(JSON.parse(textOutput(corrected)).name).toBe('Corrected');
  await runtime.execute("await page.goto('about:blank');");
  const stale = await runtime.executeWebMCP('update_contact', { name: 'Stale' });
  expect(textOutput(stale)).toContain('The page changed');
});

test('a hung native WebMCP call is killed and its container removed', async ({ runtime }) => {
  await runtime.open(url, nativeHtml.replace("if (!input.name)", "if (input.name === 'hang') return new Promise(() => {}); if (!input.name)"));
  await runtime.discoverWebMCP();
  runtime.executionTimeout = 500;
  await expect(runtime.executeWebMCP('update_contact', { name: 'hang' })).rejects.toThrow('timed out');
  await runtime.close();
  await expect(execFileAsync('docker', ['inspect', runtime.name])).rejects.toThrow();
  expect(runtime.history[0].error).toContain('timed out');
});

test('structured WebMCP sends no initial or intermediate images and verifies the final page through the SDK', async ({ runtime }) => {
  await runtime.open(url, nativeHtml);
  let calls = 0;
  const client = { responses: { async create(body) {
    const nativeTool = body.tools.find(item => item.name?.endsWith('_update_contact'));
    expect(body.tools.some(item => item.name === 'verify_page')).toBe(true);
    const turn = calls++;
    if (turn === 0) {
      expect(body.input.find(item => item.role === 'user').content.map(item => item.type)).toEqual(['input_text']);
    } else {
      const result = body.input.findLast(item => item.type === 'function_call_output');
      if (turn === 1) {
        expect(result.output.map(item => item.type)).toEqual(['input_text']);
        expect(JSON.parse(result.output[0].text).name).toBe('Alex Taylor');
      } else {
        expect(result.output.find(item => item.type === 'input_image').image_url).toMatch(/^data:image\/png;base64,iVBOR/);
      }
    }
    return {
      id: 'structured_' + turn, status: 'completed',
      output: turn < 2 ? [{
        id: 'structured_fc_' + turn, type: 'function_call', call_id: 'structured_call_' + turn,
        name: turn === 0 ? nativeTool.name : 'verify_page',
        arguments: JSON.stringify(turn === 0 ? { name: 'Alex Taylor' } : {}), status: 'completed',
      }] : [{
        id: 'structured_msg', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Visually verified.', annotations: [] }],
      }],
    };
  } } };
  const result = await runBrowserTask(runtime, 'Fill the name without submitting.', {
    model: new OpenAIResponsesModel(client, 'gpt-6-astra'), requiredWebMCPTool: 'update_contact', structuredWebMCP: true,
  });
  expect(result.finalOutput).toBe('Visually verified.');
  expect(calls).toBe(3);
  expect(runtime.initialImageCount).toBe(0);
  expect(runtime.history.map(entry => entry.type)).toEqual(['webmcp', 'verify_page']);
  expect(runtime.history[0].output.every(item => item.type === 'text')).toBe(true);
  expectScreenshot(runtime.history[1].output);
});

test('structured observations preserve native and script errors, allow correction, and reset for a new page', async ({ runtime }) => {
  await runtime.open(url, nativeHtml);
  await runtime.discoverWebMCP();
  runtime.structuredObservations = true;
  const failed = await runtime.executeWebMCP('update_contact', { name: '' });
  expect(textOutput(failed)).toContain('WebMCP error:');
  expect(failed.every(item => item.type === 'text')).toBe(true);
  const scriptError = await runtime.execute("throw new Error('Try again');");
  expect(textOutput(scriptError)).toContain('Script error: Try again');
  expect(scriptError.every(item => item.type === 'text')).toBe(true);
  const corrected = await runtime.execute("await page.locator('[name=name]').fill('Corrected');");
  expect(textOutput(corrected)).toBe('Action completed.');
  expect(corrected.every(item => item.type === 'text')).toBe(true);
  expectScreenshot(await runtime.verifyPage());
  await runtime.open(url, nativeHtml);
  expect(runtime.structuredObservations).toBe(false);
  expectScreenshot(await runtime.execute("console.log(await page.title());"));
});
