import { setTimeout as delay } from 'node:timers/promises';

const keys = {
  CTRL: 'Control', CONTROL: 'Control', ALT: 'Alt', SHIFT: 'Shift',
  CMD: 'Meta', COMMAND: 'Meta', META: 'Meta', SUPER: 'Meta',
  ENTER: 'Enter', RETURN: 'Enter', TAB: 'Tab', ESC: 'Escape', ESCAPE: 'Escape',
  SPACE: 'Space', BACKSPACE: 'Backspace', DELETE: 'Delete',
  UP: 'ArrowUp', DOWN: 'ArrowDown', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight',
  ARROWUP: 'ArrowUp', ARROWDOWN: 'ArrowDown', ARROWLEFT: 'ArrowLeft', ARROWRIGHT: 'ArrowRight',
  HOME: 'Home', END: 'End', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown',
};

// Implements the SDK's Computer interface. These methods are not separate agent tools.
// The model sees screenshots and requests coordinates/keystrokes, never DOM selectors.
export function createPlaywrightComputer(page) {
  const { width, height } = page.viewportSize();
  return {
    environment: 'browser',
    dimensions: [width, height],
    async screenshot() {
      return (await page.screenshot({ type: 'png', scale: 'css' })).toString('base64');
    },
    async click(x, y, button = 'left') {
      console.log('[computer] click', x, y, button);
      if (button === 'back') return page.goBack();
      if (button === 'forward') return page.goForward();
      await page.mouse.click(x, y, { button: button === 'wheel' ? 'middle' : button });
    },
    async doubleClick(x, y) {
      await page.mouse.dblclick(x, y);
    },
    async scroll(x, y, scrollX, scrollY) {
      await page.mouse.move(x, y);
      await page.mouse.wheel(scrollX, scrollY);
      await delay(150); // Allow the wheel action to render before the SDK captures the screen.
    },
    async type(text) {
      console.log('[computer] type', text);
      await page.keyboard.insertText(text);
    },
    async keypress(pressed) {
      console.log('[computer] keypress', pressed.join('+'));
      const normalized = pressed.map((key) => keys[key.toUpperCase()] ??
        (key.length === 1 ? key.toLowerCase() : key));
      await page.keyboard.press(normalized.join('+'));
    },
    async move(x, y) {
      await page.mouse.move(x, y);
    },
    async drag(path) {
      if (!path.length) throw new Error('Drag requires at least one coordinate.');
      await page.mouse.move(...path[0]);
      await page.mouse.down();
      try {
        for (const [x, y] of path.slice(1)) await page.mouse.move(x, y);
      } finally {
        await page.mouse.up();
      }
    },
    async wait() {
      await delay(500);
    },
  };
}
