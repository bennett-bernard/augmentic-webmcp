import { test, expect } from '@playwright/test';
import { Runner, Usage } from '@openai/agents';
import { createBrowserAgent } from '../src/browser-agent.mjs';

// Only the smoke test uses HTML supplied by the test. No website or server is needed.
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

test('computer tool fills and submits a form through the SDK', async ({ page }) => {
  await page.route('**/*', (route) => route.request().url() === url
    ? route.fulfill({ contentType: 'text/html', body: html })
    : route.abort());
  await page.goto(url);

  // Only this scripted model uses test locators to choose known coordinates.
  // A live model receives screenshots, never these locators or the fixture HTML.
  async function clickAt(locator) {
    const box = await locator.boundingBox();
    return { type: 'click', x: box.x + box.width / 2, y: box.y + box.height / 2, button: 'left' };
  }
  const batches = [
    [{ type: 'screenshot' }],
    [
      await clickAt(page.getByRole('textbox', { name: 'Name', exact: true })),
      { type: 'type', text: 'Replace this name' },
      { type: 'keypress', keys: ['CTRL', 'A'] },
      { type: 'type', text: fields.Name },
      { type: 'keypress', keys: ['TAB'] },
      { type: 'type', text: fields.Email },
      { type: 'keypress', keys: ['TAB'] },
      { type: 'type', text: fields.Message },
    ],
    [await clickAt(page.getByRole('button', { name: 'Send message' }))],
  ];
  let turn = 0;
  const scriptedModel = {
    async getResponse(request) {
      expect(request.tools.map(({ name }) => name)).toEqual(['web_search', 'computer']);
      expect(request.tools.some(({ type }) => type === 'function')).toBe(false);
      if (turn > 0) {
        const screenshot = request.input.findLast((item) => item.type === 'computer_call_result');
        expect(screenshot.output.type).toBe('computer_screenshot');
        expect(screenshot.output.data.startsWith('data:image/png;base64,iVBOR')).toBe(true);
      }
      if (turn === 2) {
        for (const [name, value] of Object.entries(fields)) {
          await expect(page.getByRole('textbox', { name, exact: true })).toHaveValue(value);
        }
        await expect(page.getByRole('status')).toBeEmpty();
      }
      const actions = batches[turn++];
      if (actions) {
        return {
          usage: new Usage(),
          output: [{ type: 'computer_call', callId: 'call-' + turn,
            status: 'completed', action: actions[0], actions }],
        };
      }
      await expect(page.getByRole('status')).toHaveText(successText);
      return {
        usage: new Usage(),
        output: [{ type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Done.' }] }],
      };
    },
    async *getStreamedResponse() {
      throw new Error('This smoke test does not use streaming.');
    },
  };

  const result = await new Runner({ tracingDisabled: true }).run(
    createBrowserAgent(page, scriptedModel),
    'Fill the open contact form and submit the pretend inquiry using the computer tool.',
    { maxTurns: 6 },
  );
  expect(result.finalOutput).toBe('Done.');
  expect(turn).toBe(batches.length + 1);
  await expect(page.getByRole('status')).toHaveText(successText);
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('');
});
