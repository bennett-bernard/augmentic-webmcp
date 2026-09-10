import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const imageName = 'augmentic-browser-runtime:local';

export class BrowserRuntime {
  constructor({ viewport = { width: 1280, height: 800 }, offline = false, executionTimeout = 15_000 } = {}) {
    this.viewport = viewport;
    this.offline = offline;
    this.executionTimeout = executionTimeout;
    this.history = [];
    this.structuredObservations = false;
    this.initialImageCount = 0;
    this.webmcp = { status: 'not-discovered', tools: [] };
    this.name = 'augmentic-browser-' + randomUUID();
    this.pending = new Map();
    this.sequence = 0;
  }

  async start() {
    this.child = spawn('docker', [
      'run', '--rm', '--interactive', '--init', '--pull=never', '--name', this.name,
      '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--user', 'pwuser', '--memory=1g', '--memory-swap=1g', '--cpus=1', '--pids-limit=256',
      '--shm-size=256m', '--tmpfs', '/tmp:rw,nosuid,size=256m',
      '--network', this.offline ? 'none' : 'bridge', imageName,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let stderr = '';
    const stop = (error) => {
      this.fail(error);
      // Preserve a cleanup failure for close() without an unhandled rejection.
      this.close().catch(() => {});
    };
    this.child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8_000); });
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024 * 1024) {
        stop(new Error('Browser runtime output exceeded 64 MiB.'));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const response = JSON.parse(line);
          const pending = this.pending.get(response.id);
          if (!pending) continue;
          this.pending.delete(response.id);
          if (response.error) pending.reject(new Error(response.error));
          else pending.resolve(response.result);
        } catch {
          stop(new Error('Invalid response from browser runtime.'));
        }
      }
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('exit', () => this.fail(new Error(
      'Browser runtime exited. Run npm run sandbox:build and ensure Docker is running.\n' + stderr,
    )));
    try {
      await this.request('init', { viewport: this.viewport }, { timeout: 30_000 });
      return this;
    } catch (error) {
      try {
        await this.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], error.message + '; container cleanup also failed.');
      }
      throw error;
    }
  }

  fail(error) {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async request(method, args = {}, { timeout = this.executionTimeout, signal } = {}) {
    if (this.failure) throw this.failure;
    if (!this.child || this.closing) throw new Error('Browser runtime is not running.');
    signal?.throwIfAborted();
    const id = ++this.sequence;
    let timer, onAbort;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        const stop = (error) => {
          // Kill the entire container: racing a Promise does not stop running code.
          this.fail(error);
          this.close().catch(() => {});
        };
        timer = setTimeout(() => stop(new Error('Browser runtime timed out during ' + method + '; stopping its container.')), timeout);
        onAbort = () => stop(signal.reason ?? new Error('Browser task aborted.'));
        signal?.addEventListener('abort', onAbort, { once: true });
        this.child.stdin.write(JSON.stringify({ id, method, ...args }) + '\n', (error) => {
          if (error) stop(error);
        });
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      this.pending.delete(id);
    }
  }

  open(url, html) {
    this.webmcp = { status: 'not-discovered', tools: [] };
    this.structuredObservations = false;
    this.initialImageCount = 0;
    return this.request('open', { url, html }, { timeout: 35_000 });
  }

  async discoverWebMCP({ signal } = {}) {
    this.webmcp = await this.request('webmcp_discover', {}, { signal });
    this.webmcp.tools = this.webmcp.tools.map((tool, index) => ({
      ...tool,
      // Preserve the native name separately; SDK function names have tighter rules.
      agentToolName: `webmcp_${index}_${tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 45)}`,
    }));
    return this.webmcp;
  }

  async executeWebMCP(name, input, { signal } = {}) {
    const tool = this.webmcp.tools.find(tool => tool.name === name);
    if (this.webmcp.status !== 'ready' || !tool) throw new Error('WebMCP tool was not exposed to this agent: ' + name);
    return this.recordExecution('webmcp_call', {
      name, input, origin: tool.origin, url: this.webmcp.url, includeScreenshot: !this.structuredObservations,
    }, { type: 'webmcp', name, input, origin: tool.origin }, signal);
  }

  async execute(code, { signal } = {}) {
    return this.recordExecution('execute', { code, includeScreenshot: !this.structuredObservations }, { type: 'exec_js', code }, signal);
  }

  async verifyPage({ signal } = {}) {
    return this.recordExecution('verify_page', {}, { type: 'verify_page' }, signal);
  }

  async recordExecution(method, args, entry, signal) {
    this.history.push(entry);
    const started = Date.now();
    try {
      const result = await this.request(method, args, { signal });
      Object.assign(entry, result);
      return result.output;
    } catch (error) {
      entry.error = error.message;
      throw error;
    } finally {
      entry.durationMs = Date.now() - started;
    }
  }

  async screenshot(fullPage = false) {
    return Buffer.from(await this.request('screenshot', { fullPage }), 'base64');
  }

  async trace() {
    return Buffer.from(await this.request('trace'), 'base64');
  }

  async close() {
    if (this.closing) return this.closing;
    this.fail(new Error('Browser runtime closed.'));
    this.closing = (async () => {
      try {
        await execFileAsync('docker', ['rm', '--force', this.name], { timeout: 10_000 });
      } catch (error) {
        if (!error.stderr?.includes('No such container')) throw error;
      } finally {
        this.child?.stdin.destroy();
        this.child?.kill('SIGKILL');
      }
    })();
    return this.closing;
  }
}
