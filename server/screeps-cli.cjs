#! /usr/bin/env node
// @ts-ignore We can't load that from the outer non-Node 10 side
const repl = require('repl');
const q = require('q');
const net = require('net');
const path = require('path');
const os = require('os');
const fs = require('fs');
const vm = require('vm');
const readline = require('readline');

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
 * Hierarchical completion tree keyed by the "dotted path" prefix.
 * Root-level keys correspond to the first segment before a dot.
 *
 * Leaf entries are either:
 *  - an empty string '' meaning "this key is a complete token"
 *  - a nested object with further keys
 *  - a function(line) => [completions, prefix] | null for complex, context-
 *    sensitive completions (e.g. storage.db[...] syntax).
 * @type {CompletionTree}
 */
const COMPLETION_TREE = {
  // Built-in helpers
  'help(': '',
  'print(': '',
  storage: {
    /** @type {CompletionResult} */
    db: (line) => {
      // From help(storage.db)
      debug('db completer', line);
      const collections = [
        'leaderboard.power',
        'leaderboard.seasons',
        'leaderboard.world',
        'users.intents',
        'market.orders',
        'market.stats',
        'rooms',
        'rooms.objects',
        'rooms.flags',
        'rooms.intents',
        'rooms.terrain',
        'transactions',
        'users',
        'users.code',
        'users.console',
        'users.messages',
        'users.money',
        'users.notifications',
        'users.resources',
        'users.power_creeps',
      ];
      const methods = [
        'find(',
        'findOne(',
        'findEx(',
        'by(',
        'count(',
        'ensureIndex(',
        'remove(',
        'insert(',
        'update(',
        'drop(',
        'clear(',
        'removeWhere(',
        'bulk(',
      ];

      // Bare `storage.db` at end of line → advance to storage.db['
      let m = line.match(/^(.*\bstorage\.db)$/);
      if (m) {
        const token = m[1];
        return [[`${token}['`], token];
      }

      m = line.match(/storage\.db\[['"]([^'"]*)$/);
      if (m) {
        const prefix = m[1] || '';
        const base = prefix
          ? collections.filter(c => c.startsWith(prefix))
          : collections;
        const hits = base.map(c => c + "']");
        debug('db completions', hits, prefix);
        return [hits, prefix];
      }

      // Exact storage.db['collection'] (no trailing dot yet) → suggest "."
      m = line.match(/storage\.db\[['"][^'"]+['"]\]$/);
      if (m) {
        return [['.'], ''];
      }

      // storage.db['collection'].<method> completions
      m = line.match(/storage\.db\[['"][^'"]+['"]\]\.([A-Za-z0-9_]*)$/);
      if (m) {
        const prefix = m[1];
        const hits = prefix
          ? methods.filter(c => c.startsWith(prefix))
          : methods;
        debug('db completions', hits.length ? hits : methods, prefix);
        return [hits.length ? hits : methods, prefix];
      }

      return null;
    },
    pubsub: {
      'keys': {
        // XXX: those are actually dynamic
        QUEUE_DONE: '',
        RUNTIME_RESTART: '',
        TICK_STARTED: '',
        ROOMS_DONE: '',
      },
      'ee': '', // XXX: someone's adding the event emitter here
      'subscribed(': () => null,
      'publish(': () => null,
      'subscribe(': () => null,
      'once(': () => null,
    },
    env: {
      keys: {
        // XXX: those are actually dynamic
        ACCESSIBLE_ROOMS: '',
        ROOM_STATUS_DATA: '',
        MEMORY: '',
        GAMETIME: '',
        MAP_VIEW: '',
        TERRAIN_DATA: '',
        SCRIPT_CACHED_DATA: '',
        USER_ONLINE: '',
        MAIN_LOOP_PAUSED: '',
        ROOM_HISTORY: '',
        ROOM_VISUAL: '',
        MEMORY_SEGMENTS: '',
        PUBLIC_MEMORY_SEGMENTS: '',
        ROOM_EVENT_LOG: '',
        ACTIVE_ROOMS: '',
        MAIN_LOOP_MIN_DURATION: '',
      },
      'get(': () => null,
      'mget(': () => null,
      'set(': () => null,
      'setex(': () => null,
      'expire(': () => null,
      'ttl(': () => null,
      'del(': () => null,
      'hmset(': () => null,
    },
  },
  // From help(map)
  map: {
    'generateRoom(': () => null,
    'openRoom(': () => null,
    'closeRoom(': () => null,
    'removeRoom(': () => null,
    'updateRoomImageAssets(': () => null,
    'updateTerrainData()': '',
  },
  // From help(bots)
  bots: {
    'spawn(': '',
    'reload(': '',
    'removeUser(': '',
  },
  // From help(strongholds)
  strongholds: {
    'spawn(': '',
    'expand(': '',
  },
  // From help(system)
  system: {
    'resetAllData()': '',
    'sendServerMessage()': () => null,
    'pauseSimulation()': '',
    'resumeSimulation()': '',
    'runCronjob(': () => null,
    'getTickDuration(': () => null,
    'setTickDuration(': () => null,
  },
  utils: {
    'addNPCTerminals(': () => null,
    'removeNPCTerminals()': '',
    'removeBots(': () => null,
    'setSocketUpdateRate(': () => null,
    'getSocketUpdateRate(': () => null,
    'setShardName(': () => null,
    'banUser(': () => null,
    'unbanUser(': () => null,
    'getCPULimit(': () => null,
    'setCPULimit(': () => null,
    'resetCPULimit(': () => null,
    'enableGCLToCPU(': () => null,
    'disableGCLToCPU()': '',
    'importMap(': () => null,
    'importMapFile(': () => null,
    'exportMap()': '',
    'getStats()': '',
    'getWhitelist(': () => null,
    'addWhitelistUser(': () => null,
    'removeWhitelistUser(': () => null,
  }
};

/**
 * REPL completer for the CLI
 * @param {string} line
 * @returns {import("readline").CompleterResult}
 */
function screepsCompleter(line) {
  const tokenMatch = line.match(/([A-Za-z0-9_.$()[\]'"]+\.?)$/);
  if (!tokenMatch) {
    // No identifiable token: fallback to root-level completions.
    debug('no token', Object.keys(COMPLETION_TREE), '');
    return [Object.keys(COMPLETION_TREE), ''];
  }

  const token = tokenMatch[1];
  const parts = token.endsWith('.')
    ? token.slice(0, -1).split('.').concat([''])
    : token.split('.');

  debug("completing:", line, "token:", token, "parts:", parts);

  // Walk the tree along each dotted segment.
  /** @type {CompletionNode | null} */
  let node = COMPLETION_TREE;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const barePart = i === parts.length - 1
      // For the last segment, strip off any non-identifier suffix so that
      // stuff like "db['" still maps to the "db" key in the tree.
      ? part.replace(/[^A-Za-z0-9_$].*$/, '')
      : part;
    const isLast = i === parts.length - 1;

    // If the current node is a dynamic completer, delegate to it.
    if (typeof node === 'function') {
      const res = node(line);
      if (res) return res;
      break;
    }

    // If we're not at an object, we can't go deeper – fall back to root.
    if (!node || typeof node !== 'object') {
      debug("no node or not an object", barePart);
      break;
    }

    if (!isLast) {
      // Intermediate segment must match exactly to keep drilling down.
      if (barePart && Object.prototype.hasOwnProperty.call(node, barePart)) {
        node = node[barePart];
        continue;
      }

      // If there is a dynamic child whose key is a prefix of this segment,
      // delegate to it (e.g. "db['leaderboard" should match "db").
      const dynKey = Object.keys(node).find(
        k => typeof node[k] === 'function' && barePart.startsWith(k),
      );
      if (dynKey) {
        const res = /** @type {CompletionResult} */ (node[dynKey])(line);
        debug("partial key completion:", res);
        if (res) return res;
      }

      // No exact or dynamic match for this path; stop and fall back to
      // top-level.
      node = null;
      break;
    }

    // Last segment: handle exact match vs. prefix within current node.
    if (Object.prototype.hasOwnProperty.call(node, barePart)) {
      const child = node[barePart];

      // Exact match leads to:
      //  - function: dynamic completion for this branch
      //  - object: list its keys as fully-qualified dotted names
      //  - '' (string leaf): nothing more to complete
      if (typeof child === 'function') {
        const res = child(line);
        debug('function completer', res);
        if (res) return res;
        break;
      }
      if (child && typeof child === 'object') {
        // At top level (e.g. "storage") suggest ".db", ".pubsub", etc so
        // the user sees what will be appended next. For nested objects,
        // suggest fully-qualified dotted names.
        if (node === COMPLETION_TREE) {
          const keys = Object.keys(child).map(k => `.${k}`);
          debug('object completer', keys, '');
          return [keys, ''];
        } else {
          const keys = Object.keys(child).map(k => `${barePart}.${k}`);
          debug('object completer', keys, barePart);
          return [keys, barePart];
        }
      }
      // Leaf string – no further completion.
      break;
    }

    // Partial match at this level: suggest matching keys from this node.
    // If the segment already contains a "(", we're in a function-call
    // argument position and shouldn't keep suggesting the function name
    // itself (e.g. avoid repeating "help(" on every Tab).
    if (!barePart.includes('(')) {
      const keys = Object.keys(node).filter(k => k.startsWith(barePart));
      if (keys.length) {
        debug('object completer (no function)', 'line', line, 'keys:', keys, 'part:', barePart);
        return [keys, barePart];
      }
    }
    // No matches; fall through to root-level fallback.
    node = null;
    break;
  }

  // We had a token, but no specific completions matched – if we're inside a
  // function call (segment containing '('), reset back to root-level objects
  // so patterns like "help(stron(" complete on root keys. Otherwise, return
  // no suggestions.
  const last = tokenMatch[1];
  const funcArgMatch = last.match(/([A-Za-z0-9_.$]+)\(/);
  if (funcArgMatch) {
    const prefix = funcArgMatch[1] || '';
    const rootKeys = Object.keys(COMPLETION_TREE).filter(k => !k.endsWith('('));
    const hits = prefix
      ? rootKeys.filter(k => k.startsWith(prefix))
      : rootKeys;
    debug('function completer', hits, prefix);
    return [hits, prefix];
  }
  debug('no hits', [], '');
  return [[], ''];
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
  /** @type {repl.REPLServer} */
  let rl;
  let connected = false;

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

  socket.on('connect', () => {
    connected = true;

    if (cmd) {
      // Running in command mode, we're just gonna send the provided command,
      // wait for an answer and exit immediately.
      socket.on("data", data => {
        const string = data.toString('utf8');
        const cleaned = string.replace(/^< /, '').replace(/\n< /g, '\n');
        if (cleaned.match(/^Screeps server v.* running on port .*/)) {
          // Skip over server connection answer
          return;
        }

        process.stdout.write(cleaned);
        process.exit(1);
      });
      executeCommand(cmd);
      return;
    }

    defer.resolve();
    rl = repl.start({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
      eval: replEval,
      completer: screepsCompleter,
    });

    try {
      // @ts-expect-error I'm guessing this is a private ivar of REPL?
      rl.history = JSON.parse(fs.readFileSync(HISTORY_FILE).toString('utf8'));
    } catch (err) {}

    rl.on('close', () => {
      // @ts-expect-error I'm guessing this is a private ivar of REPL?
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(rl.history));
      socket.end();
    });

    rl.on('exit', () => {
      rl.output.write(`Disconnecting…\r\n`);
      socket.end();
    });

    rl.output.write(`Screeps CLI connected on ${host}:${port}.\r\n-----------------------------------------\r\n`);
  });

  socket.on('data', (data) => {
    if (!rl) return;
    const string = data.toString('utf8');
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
