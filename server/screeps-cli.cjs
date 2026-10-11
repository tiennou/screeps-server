#! /usr/bin/env node
const repl = require('repl');
const q = require('q');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const vm = require('vm');
const readline = require('readline');
const {
  createCompleter,
  emptyCatalog,
  catalogRequests,
  applyCatalogSlice,
  readStashSnippet,
  parseCatalogResult,
} = require('./screeps-completer.cjs');

/** How long one background completion query may take before Tab gives up on it. */
const CATALOG_TIMEOUT_MS = 8000;

const HISTORY_FILE = (() => {
  const filePath = process.env.CLI_HISTORY_FILE;
  if (filePath) {
    if (path.isAbsolute(filePath)) {
      return filePath;
    } else {
      return path.normalize(path.join(os.homedir(), filePath));
    }
  }
  return path.join(os.homedir(), '.screeps-history');
})();

/**
 * @param  {...any} args
 */
function debug(...args) {
  if (true) return;
  console.log("\n", ...args);
}

/**
 * A result line from the CLI socket is `"< " + text`. Anything else is server
 * output (the greeting, or a `print`).
 * @param {string} line
 * @returns {string | null}
 */
function stripCliResult(line) {
  if (line.startsWith('< ')) return line.slice(2).trim();
  if (/^<\s*$/.test(line)) return '';
  return null;
}

/**
 * @param {string} host
 * @param {number} port
 * @param {string} [cmd]
 * @returns
 */
function cli(host, port, cmd = undefined) {

  const defer = q.defer();

  const socket = net.connect(port, host);
  /** @type {repl.REPLServer | undefined} */
  let rl;
  let connected = false;
  let commandAnswered = false;
  /** @type {(chunk: string) => void} */
  let onSocketData = () => {};
  socket.on('data', (data) => onSocketData(data.toString('utf8')));

  /**
   * Send a command to the server for execution
   * @param {string} input
   */
  const executeCommand = (input) => {
    // The server side feeds the socket through `readline`, which splits on
    // newlines. To avoid breaking multi-line input into multiple commands,
    // we collapse internal newlines into spaces before sending.
    const toSend = input
      .replace(/\r?\n$/, '')   // drop the final newline REPL adds
      .replace(/\r?\n/g, ' '); // turn internal newlines into spaces

    debug('sent', toSend + "\r\n");
    socket.write(toSend + "\r\n");
  }

  /**
   * Evaluate the REPL input
   * @param {string} input
   * @param {vm.Context} context
   * @param {string} filename
   * @param {(err: Error | null, result?: any) => void} callback
   */
  const replEval = (input, context, filename, callback) => {
    try {
      // Using "vm.Script" lets use the V8 parser to check for syntax validity.
      new vm.Script(input, { filename });
    } catch (err) {
      if (!(err instanceof Error)) {
        console.error('Unexpected error from repl eval', err);
        process.exit(1);
        return;
      }
      if (isRecoverableError(err)) {
        return callback(new repl.Recoverable(err));
      }
      return callback(err);
    }

    // At this point the input is complete JS. Pass the whole buffered input
    // to the socket, so multi-line constructs (like function definitions)
    // are already combined.
    executeCommand(input);
    callback(null);
  };

  /**
   * Decide whether a syntax error is recoverable (i.e. REPL should keep
   * accepting more input instead of erroring immediately).
   *
   * @param {Error} error
   * @returns {boolean}
   */
  function isRecoverableError(error) {
    if (error.name === 'SyntaxError') {
      return /^(Unexpected end of input|Unexpected token)/.test(error.message);
    }
    return false;
  }

  /**
   * @param {string} string
   */
  const showServerOutput = (string) => {
    if (!rl) return;
    const cleaned = string.replace(/^< /, '').replace(/\n< /g, '\n');

    // Clear the current input line (prompt + user-typed text),
    // print the server output, then redraw the prompt and buffer so
    // asynchronous logs don't interleave with what the user is typing.
    readline.clearLine(rl.output, 0);
    readline.cursorTo(rl.output, 0);
    rl.output.write(cleaned);
    if (!/\n$/.test(cleaned)) {
      rl.output.write('\n');
    }
    rl.displayPrompt(true);
  };

  const complete = createCompleter(emptyCatalog());
  let socketBuf = '';
  let pendingOutput = '';
  /** @type {Map<string, (result: { ready: string } | { id: string, data: unknown }) => void>} */
  const catalogWaiters = new Map();
  /** @type {Map<string, Promise<void>>} */
  const catalogInflight = new Map();

  /**
   * @param {string} text
   */
  const showOrBuffer = (text) => {
    if (!text) return;
    if (!rl) {
      pendingOutput += text;
      return;
    }
    showServerOutput(text);
  };

  /**
   * @param {string} key
   * @returns {Promise<{ ready: string } | { id: string, data: unknown }>}
   */
  const waitCatalog = (key) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        catalogWaiters.delete(key);
        reject(new Error(`Completion query timed out: ${key}`));
      }, CATALOG_TIMEOUT_MS);
      catalogWaiters.set(key, (result) => {
        clearTimeout(timer);
        catalogWaiters.delete(key);
        resolve(result);
      });
    });
  };

  /**
   * @param {string} body
   * @returns {boolean}
   */
  const dispatchCatalog = (body) => {
    const parsed = parseCatalogResult(body);
    if (!parsed) return false;
    const key = 'ready' in parsed ? `ready:${parsed.ready}` : parsed.id;
    const waiter = catalogWaiters.get(key);
    if (waiter) waiter(parsed);
    return true;
  };

  /**
   * @param {string} chunk
   */
  const handleInteractiveData = (chunk) => {
    socketBuf += chunk;
    if (socketBuf.length > 1_000_000 && !socketBuf.includes('\n')) {
      showOrBuffer(socketBuf);
      socketBuf = '';
      return;
    }
    let ordinary = '';
    let nl = socketBuf.indexOf('\n');
    while (nl !== -1) {
      const line = socketBuf.slice(0, nl).replace(/\r$/, '');
      socketBuf = socketBuf.slice(nl + 1);
      const body = stripCliResult(line);
      if (body !== null && dispatchCatalog(body)) {
        nl = socketBuf.indexOf('\n');
        continue;
      }
      ordinary += line + '\n';
      nl = socketBuf.indexOf('\n');
    }
    showOrBuffer(ordinary);
  };

  /**
   * @param {{ id: string, async: boolean, source: string }} query
   * @returns {Promise<void>}
   */
  const runCatalogQuery = async (query) => {
    try {
      /** @type {{ ready: string } | { id: string, data: unknown }} */
      let parsed;
      if (!query.async) {
        const pending = waitCatalog(query.id);
        executeCommand(query.source);
        parsed = await pending;
      } else {
        const ready = waitCatalog(`ready:${query.id}`);
        executeCommand(query.source);
        await ready;
        const pending = waitCatalog(query.id);
        executeCommand(readStashSnippet(query.id));
        parsed = await pending;
      }
      const data = parsed && 'data' in parsed ? parsed.data : [];
      applyCatalogSlice(complete.catalog, { id: query.id, data });
    } catch {
      applyCatalogSlice(complete.catalog, { id: query.id, data: [] });
    }
  };

  /**
   * @param {{ id: string, async: boolean, source: string }} query
   * @returns {Promise<void>}
   */
  const loadCatalogQuery = (query) => {
    const existing = catalogInflight.get(query.id);
    if (existing) return existing;
    const task = runCatalogQuery(query).finally(() => {
      catalogInflight.delete(query.id);
    });
    catalogInflight.set(query.id, task);
    return task;
  };

  /**
   * Node's readline only uses the callback. Length 2 keeps it from wrapping
   * this as a sync completer.
   * @param {string} line
   * @param {(err: Error | null, result: import("readline").CompleterResult) => void} callback
   */
  function completer(line, callback) {
    const queries = catalogRequests(line, complete.catalog);
    if (!queries.length) {
      callback(null, complete(line));
      return;
    }
    Promise.all(queries.map(loadCatalogQuery)).then(
      () => callback(null, complete(line)),
      () => callback(null, complete(line)),
    );
  }

  const startRepl = () => {
    onSocketData = handleInteractiveData;
    rl = repl.start({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
      eval: replEval,
      completer,
    });

    try {
      // @ts-expect-error I'm guessing this is a private ivar of REPL?
      rl.history = JSON.parse(fs.readFileSync(HISTORY_FILE).toString('utf8'));
    } catch (err) {}

    rl.on('close', () => {
      if (!rl) return;
      // @ts-expect-error I'm guessing this is a private ivar of REPL?
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(rl.history));
      socket.end();
    });

    rl.on('exit', () => {
      if (!rl) return;
      rl.output.write(`Disconnecting…\r\n`);
      socket.end();
    });

    rl.output.write(`Screeps CLI connected on ${host}:${port}.\r\n-----------------------------------------\r\n`);
    if (pendingOutput) {
      const flushed = pendingOutput;
      pendingOutput = '';
      showServerOutput(flushed);
    }
    defer.resolve();
  };

  socket.on('connect', () => {
    connected = true;

    if (cmd) {
      // Running in command mode, we're just gonna send the provided command,
      // wait for an answer and exit immediately.
      onSocketData = (string) => {
        const cleaned = string.replace(/^< /, '').replace(/\n< /g, '\n');
        if (cleaned.match(/^Screeps server v.* running on port .*/)) {
          // Skip over server connection answer
          return;
        }

        commandAnswered = true;
        process.stdout.write(cleaned);
        process.exit(0);
      };
      executeCommand(cmd);
      return;
    }

    startRepl();
  });
  
  socket.on('error', (error) => {
    if (!connected) {
      console.error(`Failed to connect to ${host}:${port}: ${error.message}`);
    } else {
      console.error(`Socket error: ${error.message}`);
    }
    defer.reject(error);
    process.exit(1);
  });

  socket.on('close', () => {
    if (rl) {
      rl.close();
    }
    if (cmd) {
      process.exit(!commandAnswered ? 1 : 0);
      return;
    }
    process.exit(0);
  });
  
  return defer.promise;
};

// Command line options and arguments
/** @type {string | undefined} */
let host = undefined;
/** @type {number | undefined} */
let port = undefined;
/** @type {string | undefined} */
let command = undefined;

// Janky option parsing
const argStart = process.argv.findIndex(arg => arg === __filename) + 1;
const ARGV = process.argv.slice(argStart);
while (ARGV.length) {
  if (ARGV[0][0] === "-") {
    if (ARGV[0] === "-c") {
      ARGV.shift()
      command = ARGV.shift();
    } else {
      console.error(`Unknown option ${ARGV[0]}`);
    }
  } else {
    if (host === undefined) {
      host = ARGV.shift();
    } else if (port === undefined) {
      const portStr = ARGV.shift();
      if (portStr === undefined) {
        console.error(`Missing port number ${portStr}`);
        process.exit(1);
      }
      const portNum = parseInt(portStr, 10);
      if (isNaN(portNum)) {
        console.error(`Invalid port number ${portStr}`);
        process.exit(1);
      }
      port = portNum;
    } else {
      console.error(`Unknown argument ${ARGV[0]}`);
      process.exit(1);
    }
  }
}

host = host || "localhost";
port = port || 21026;

cli(host, port, command);
