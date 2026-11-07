/**
 * Tab completion for the Screeps server CLI.
 *
 * Call `createCompleter(catalog)` with whatever is already known. `null` lists
 * are not loaded yet. The CLI fills those by running `catalogRequests()` on
 * Tab: each request is a small sandbox snippet, not a startup dump.
 * The returned function takes the text before the cursor and returns readline's
 * `[completions, prefix]` pair. Prefix is always a suffix of that text, which
 * is what Node uses to decide what to insert. The tree is rebuilt from the
 * catalog on each call, so a slice applied between calls shows up immediately.
 *
 * The command tree covers the stock CLI sandbox plus the commands registered
 * by the mods this server loads (screepsmod-admin-utils, screepsmod-auth,
 * screepsmod-mongo). Key names and collection fields come from `catalog`.
 *
 * Leaf entries are either:
 *  - an empty string '' meaning "this key is a complete token"
 *  - a nested object with further keys
 *  - a path function(text) for syntax that is not a dotted identifier
 *    (storage.db['...'])
 *  - an args() completer, used once the call's `(` is still open
 *
 * Call names include `(` or `()` so Tab inserts the invocation.
 */

/**
 * Mark a call whose open arguments can be completed.
 * Path completion still inserts `name(`; `complete` runs while that `(` is open.
 * @param {(ctx: ArgContext) => import("readline").CompleterResult | null} complete
 * @returns {ArgCompleter}
 */
function args(complete) {
  /**
   * @param {ArgContext} ctx
   * @returns {import("readline").CompleterResult | null}
   */
  function argCompleter(ctx) {
    return complete(ctx);
  }
  return /** @type {ArgCompleter} */ (Object.assign(argCompleter, { kind: 'args' }));
}

/**
 * @param {CompletionNode | null | undefined} node
 * @returns {node is ArgCompleter}
 */
function isArgCompleter(node) {
  if (typeof node !== 'function') return false;
  return /** @type {ArgCompleter} */ (node).kind === 'args';
}

/**
 * @param {CompletionNode | undefined} node
 * @returns {node is CompletionResult}
 */
function isPathCompleter(node) {
  return typeof node === 'function' && !isArgCompleter(node);
}

/** Stock backend cronjobs, plus screepsmod-auth and screepsmod-admin-utils. */
const CRONJOBS = [
  'authUpdates',
  'calcMarketStats',
  'deletePowerCreeps',
  'expandStrongholds',
  'fixAllowed',
  'gcltocpu',
  'genDeposits',
  'genInvaders',
  'genPowerBanks',
  'genStrongholds',
  'inactiveUserCleanup',
  'purgeTransactions',
  'recreateNpcOrders',
  'roomsForceUpdate',
  'screepsLauncherConfig',
  'sendNotifications',
  'stats',
];

const DB_METHODS = [
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

const QUERY_METHODS = new Set([
  'find',
  'findOne',
  'findEx',
  'by',
  'count',
  'remove',
  'removeWhere',
  'update',
  'insert',
]);

const ENV_METHODS = [
  'get',
  'mget',
  'set',
  'setex',
  'expire',
  'ttl',
  'del',
  'hmget',
  'hmset',
  'hget',
  'hset',
  'hgetall',
  'incr',
  'sadd',
  'smembers',
];

const PUBSUB_METHODS = ['publish', 'subscribe', 'once'];

/**
 * Field name → which sampled value list to offer.
 * `usernameLower` completes usernames; `_id` is chosen per collection.
 * @type {Record<string, keyof CompletionCatalog['values']>}
 */
const FIELD_KINDS = {
  username: 'username',
  usernameLower: 'username',
  email: 'email',
  user: 'userId',
  userId: 'userId',
  room: 'room',
  roomName: 'room',
  type: 'type',
};

const VALUE_ARG_FUNCTIONS = new Set(['help', 'print']);

const CATALOG_VALUE_CAP = 500;

/**
 * A background completion query. `source` is sandbox JS. Async queries resolve
 * a promise (so the server `util.inspect`s the result); they stash the payload
 * and resolve to `@@c:ready:<id>`. `readStashSnippet(id)` then returns the
 * payload synchronously, which the server sends raw.
 * @typedef {object} CatalogQuery
 * @property {string} id
 * @property {boolean} async
 * @property {string} source
 */

/**
 * @typedef {((line: string) => import("readline").CompleterResult) & { catalog: CompletionCatalog }} ScreepsCompleter
 */

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asStringList(value) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    if (item == null || item === '') continue;
    out.push(String(item));
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {Record<string, string[]>}
 */
function asFieldMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  /** @type {Record<string, string[]>} */
  const fields = {};
  for (const name of Object.keys(value)) {
    fields[name] = asStringList(/** @type {Record<string, unknown>} */ (value)[name]);
  }
  return fields;
}

/**
 * `null` lists are not loaded. An empty array has been loaded and is empty.
 * @returns {CompletionCatalog}
 */
function emptyCatalog() {
  return {
    envKeys: null,
    pubsubKeys: null,
    collections: null,
    fields: {},
    values: {
      username: null,
      usernameLower: null,
      email: null,
      userId: null,
      room: null,
      type: null,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {string[] | null}
 */
function normalizeList(value) {
  if (value == null) return null;
  return asStringList(value);
}

/**
 * @param {unknown} catalog
 * @returns {CompletionCatalog}
 */
function normalizeCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return emptyCatalog();
  const source = /** @type {Partial<CompletionCatalog>} */ (catalog);
  const values = source.values || /** @type {CompletionCatalog['values']} */ ({});
  return {
    envKeys: normalizeList(source.envKeys),
    pubsubKeys: normalizeList(source.pubsubKeys),
    collections: normalizeList(source.collections),
    fields: asFieldMap(source.fields),
    values: {
      username: normalizeList(values.username),
      usernameLower: normalizeList(values.usernameLower),
      email: normalizeList(values.email),
      userId: normalizeList(values.userId),
      room: normalizeList(values.room),
      type: normalizeList(values.type),
    },
  };
}

/**
 * @param {readonly string[]} names
 * @returns {CompletionTree}
 */
function keyLeaves(names) {
  /** @type {CompletionTree} */
  const leaves = {};
  for (const name of names) leaves[name] = '';
  return leaves;
}

/**
 * Names already known. A fixture that only fills `fields` still lists those
 * collections. `null` collections and no field samples means "not loaded".
 * @param {CompletionCatalog} catalog
 * @returns {string[]}
 */
function collectionNames(catalog) {
  if (Array.isArray(catalog.collections)) return catalog.collections;
  return Object.keys(catalog.fields);
}

/**
 * @param {CompletionCatalog} catalog
 * @returns {boolean}
 */
function collectionsKnown(catalog) {
  return Array.isArray(catalog.collections) || Object.keys(catalog.fields).length > 0;
}

/**
 * `storage.db['collection'].method` is not a dotted identifier, so it cannot
 * live in the tree as plain keys. Collection names themselves contain dots.
 * @param {CompletionCatalog} catalog
 * @returns {CompletionResult}
 */
function completeDbPath(catalog) {
  return function completeDb(text) {
    const collections = collectionNames(catalog);
    let m = text.match(/^(.*\bstorage\.db)$/);
    if (m) {
      return [[`${m[1]}['`], m[1]];
    }

    m = text.match(/^(.*\bstorage\.db)\.$/);
    if (m) {
      return [["['"], ''];
    }

    m = text.match(/storage\.db\[(['"])([^'"]*)$/);
    if (m) {
      const quote = m[1];
      const prefix = m[2];
      const base = prefix
        ? collections.filter((c) => c.startsWith(prefix))
        : collections;
      return [base.map((c) => `${c}${quote}]`), prefix];
    }

    m = text.match(/storage\.db\[['"][^'"]+['"]\]$/);
    if (m) {
      return [['.'], ''];
    }

    m = text.match(/storage\.db\[['"][^'"]+['"]\]\.([A-Za-z0-9_]*)$/);
    if (m) {
      const prefix = m[1];
      const hits = DB_METHODS.filter((c) => c.startsWith(prefix));
      return [hits, prefix];
    }

    return null;
  };
}

/**
 * @param {CompletionCatalog} catalog
 * @returns {CompletionTree}
 */
function buildTree(catalog) {
  /** @type {CompletionTree | null} */
  let tree = null;

  /**
   * @param {ArgContext} ctx
   * @returns {import("readline").CompleterResult}
   */
  function completeEnvKey(ctx) {
    return completeKeyRef(/** @type {CompletionTree} */ (tree), 'storage.env.keys.')(ctx.arg);
  }

  /**
   * @param {ArgContext} ctx
   * @returns {import("readline").CompleterResult}
   */
  function completePubsubKey(ctx) {
    return completeKeyRef(/** @type {CompletionTree} */ (tree), 'storage.pubsub.keys.')(ctx.arg);
  }

  /** @type {CompletionTree} */
  const env = { keys: keyLeaves(catalog.envKeys || []) };
  for (const name of ENV_METHODS) env[`${name}(`] = args(completeEnvKey);

  /** @type {CompletionTree} */
  const pubsub = { keys: keyLeaves(catalog.pubsubKeys || []) };
  for (const name of PUBSUB_METHODS) pubsub[`${name}(`] = args(completePubsubKey);

  tree = {
    // Built-in helpers
    'help(': '',
    'print(': '',
    storage: {
      db: completeDbPath(catalog),
      env,
      pubsub,
      queue: {
        'fetch(': '',
        'add(': '',
        'addMulti(': '',
        'markDone(': '',
        'whenAllDone(': '',
        'reset(': '',
      },
    },
    // From help(map)
    map: {
      'generateRoom(': '',
      'openRoom(': '',
      'closeRoom(': '',
      'removeRoom(': '',
      'updateRoomImageAssets(': '',
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
      'sendServerMessage(': '',
      'pauseSimulation()': '',
      'resumeSimulation()': '',
      'runCronjob(': args((ctx) => completeQuoted(ctx.arg, CRONJOBS)),
      'getTickDuration()': '',
      'setTickDuration(': '',
      // screepsmod-admin-utils
      'listCronjobs()': '',
    },
    utils: {
      'addNPCTerminals(': '',
      'removeNPCTerminals()': '',
      'removeBots()': '',
      'setSocketUpdateRate(': '',
      'getSocketUpdateRate()': '',
      'setShardName(': '',
      'reloadConfig()': '',
      'banUser(': '',
      'unbanUser(': '',
      'respawnUser(': '',
      'getCPULimit(': '',
      'setCPULimit(': '',
      'resetCPULimit(': '',
      'enableGCLToCPU(': '',
      'disableGCLToCPU()': '',
      'importMap(': '',
      'importMapFile(': '',
      'exportMap()': '',
      'getStats()': '',
      'getWhitelist()': '',
      'addWhitelistUser(': '',
      'removeWhitelistUser(': '',
    },
    // screepsmod-auth
    auth: {
      'setPassword(': '',
      'createAuthToken(': '',
      'getTokenRateLimit(': '',
      'banUser(': '',
      'unbanUser(': '',
      'listUserTokenRateLimits(': '',
    },
    // screepsmod-mongo
    mongo: {
      'importDB(': '',
    },
  };
  return tree;
}

/**
 * Suggest `storage.env.keys.` / `storage.pubsub.keys.` as the first argument,
 * then complete the constant name once the user is inside that path.
 * @param {CompletionTree} tree
 * @param {string} ref
 * @returns {(arg: string) => import("readline").CompleterResult}
 */
function completeKeyRef(tree, ref) {
  return (arg) => {
    const trimmed = arg.trimStart();
    if (trimmed === '' || (ref.startsWith(trimmed) && trimmed !== ref)) {
      return [[ref], trimmed];
    }
    if (trimmed.startsWith(ref)) {
      return completePath(trimmed, tree);
    }
    return [[], ''];
  };
}

/**
 * @param {string} arg
 * @param {readonly string[]} values
 * @returns {import("readline").CompleterResult}
 */
function completeQuoted(arg, values) {
  const m = arg.match(/^\s*(?:(['"])([A-Za-z0-9_]*)|([A-Za-z0-9_]*))$/);
  if (!m) return [[], ''];
  const open = m[1] || '';
  const prefix = m[2] ?? m[3] ?? '';
  const quote = open || "'";
  const hits = values.filter((v) => v.startsWith(prefix));
  if (!hits.length) return [[], ''];
  if (open) return [hits.map((v) => `${v}${quote}`), prefix];
  return [hits.map((v) => `${quote}${v}${quote}`), prefix];
}

/**
 * @param {string} value
 * @param {string} quote
 * @returns {string}
 */
function escapeQuoted(value, quote) {
  return value.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
}

/**
 * @param {string} prefix
 * @param {string} openQuote
 * @param {readonly string[]} values
 * @returns {import("readline").CompleterResult}
 */
function completeQuotedValues(prefix, openQuote, values) {
  const quote = openQuote || "'";
  const hits = values.filter((v) => v.startsWith(prefix)).sort();
  if (!hits.length) return [[], ''];
  if (openQuote) return [hits.map((v) => `${escapeQuoted(v, quote)}${quote}`), prefix];
  return [hits.map((v) => `${quote}${escapeQuoted(v, quote)}${quote}`), prefix];
}

/**
 * @param {string} field
 * @param {string} quote
 * @returns {string}
 */
function formatKey(field, quote) {
  const body = quote ? escapeQuoted(field, quote) : field;
  const ident = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field);
  if (quote) return `${body}${quote}: `;
  if (!ident) return `'${escapeQuoted(field, "'")}': `;
  return `${field}: `;
}

/**
 * @typedef {object} KeyPos
 * @property {'key'} kind
 * @property {string} prefix
 * @property {string} quote
 */

/**
 * @typedef {object} ValuePos
 * @property {'value'} kind
 * @property {string} field
 * @property {string} prefix
 * @property {string} quote
 */

/**
 * Cursor position inside the first object literal of a call argument.
 * Nested objects and a later argument (a projection) are left alone.
 * @param {string} arg
 * @returns {KeyPos | ValuePos | null}
 */
function scanObjectArg(arg) {
  let quote = '';
  let depth = 0;
  let seenObject = false;
  /** @type {'key' | 'colon' | 'value' | 'between'} */
  let mode = 'between';
  let field = '';
  let keyPrefix = '';
  let keyQuote = '';
  let valuePrefix = '';
  let valueQuote = '';

  let i = 0;
  while (i < arg.length) {
    const c = arg[i];
    i++;

    if (quote) {
      if (c === '\\' && i < arg.length) {
        const next = arg[i];
        i++;
        if (depth === 1 && mode === 'key') keyPrefix += next;
        else if (depth === 1 && mode === 'value') valuePrefix += next;
        continue;
      }
      if (c === quote) {
        quote = '';
        if (depth === 1 && mode === 'key') mode = 'colon';
        else if (depth === 1 && mode === 'value') mode = 'between';
      } else if (depth === 1 && mode === 'key') {
        keyPrefix += c;
      } else if (depth === 1 && mode === 'value') {
        valuePrefix += c;
      }
      continue;
    }

    if (c === "'" || c === '"') {
      if (depth === 1 && mode === 'key' && keyPrefix === '' && !keyQuote) {
        keyQuote = c;
        quote = c;
        continue;
      }
      if (depth === 1 && mode === 'value' && valuePrefix === '' && !valueQuote) {
        valueQuote = c;
        quote = c;
        continue;
      }
      quote = c;
      continue;
    }

    if (c === '{' && depth === 0) {
      if (seenObject) return null;
      seenObject = true;
      depth = 1;
      mode = 'key';
      keyPrefix = '';
      keyQuote = '';
      field = '';
      continue;
    }

    if (c === '{' || c === '[') {
      depth++;
      continue;
    }

    if (c === '}' || c === ']') {
      if (depth === 0) return null;
      depth--;
      if (depth === 1) mode = 'between';
      continue;
    }

    if (depth !== 1) continue;

    if (mode === 'key') {
      if (/\s/.test(c)) {
        if (keyPrefix) {
          field = keyPrefix;
          mode = 'colon';
        }
        continue;
      }
      if (c === ',') {
        keyPrefix = '';
        keyQuote = '';
        continue;
      }
      if (c === ':') {
        if (!keyPrefix) return null;
        field = keyPrefix;
        mode = 'value';
        valuePrefix = '';
        valueQuote = '';
        continue;
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        keyPrefix += c;
        continue;
      }
      return null;
    }

    if (mode === 'colon') {
      if (/\s/.test(c)) continue;
      if (c === ':') {
        mode = 'value';
        valuePrefix = '';
        valueQuote = '';
        continue;
      }
      return null;
    }

    if (mode === 'value') {
      if (valuePrefix === '' && !valueQuote && /\s/.test(c)) continue;
      if (c === ',') {
        mode = 'key';
        keyPrefix = '';
        keyQuote = '';
        field = '';
        continue;
      }
      if (/[A-Za-z0-9_@.+-]/.test(c)) {
        valuePrefix += c;
        continue;
      }
      return null;
    }

    if (/\s/.test(c)) continue;
    if (c === ',') {
      mode = 'key';
      keyPrefix = '';
      keyQuote = '';
      field = '';
      continue;
    }
    return null;
  }

  if (!seenObject || depth !== 1) return null;
  if (mode === 'key') return { kind: 'key', prefix: keyPrefix, quote: keyQuote };
  if (mode === 'value') return { kind: 'value', field, prefix: valuePrefix, quote: valueQuote };
  return null;
}

/**
 * @param {string} collection
 * @param {string} field
 * @param {CompletionCatalog} catalog
 * @returns {string[] | null}
 */
function valuesFor(collection, field, catalog) {
  if (field === '_id') {
    if (collection === 'users') return catalog.values.userId;
    if (collection === 'rooms') return catalog.values.room;
    return null;
  }
  const kind = FIELD_KINDS[field];
  if (!kind) return null;
  return catalog.values[kind];
}

/**
 * @param {string} prefix
 * @param {string} quote
 * @param {readonly string[]} fields
 * @returns {import("readline").CompleterResult}
 */
function completeFieldKey(prefix, quote, fields) {
  const hits = fields.filter((field) => field.startsWith(prefix)).sort();
  if (!hits.length) return [[], ''];
  return [hits.map((field) => formatKey(field, quote)), prefix];
}

/**
 * @param {ArgContext} ctx
 * @returns {import("readline").CompleterResult}
 */
function completeQueryArg(ctx) {
  const pos = scanObjectArg(ctx.arg);
  if (!pos) return [[], ''];
  const fields = ctx.catalog.fields[ctx.collection] || [];
  if (pos.kind === 'key') return completeFieldKey(pos.prefix, pos.quote, fields);
  const values = valuesFor(ctx.collection, pos.field, ctx.catalog);
  if (!values) return [[], ''];
  return completeQuotedValues(pos.prefix, pos.quote, values);
}

/**
 * @param {ArgContext} ctx
 * @returns {import("readline").CompleterResult}
 */
function completeDbCall(ctx) {
  const fields = ctx.catalog.fields[ctx.collection] || [];
  if (ctx.callee === 'ensureIndex') return completeQuoted(ctx.arg, fields);
  if (QUERY_METHODS.has(ctx.callee)) return completeQueryArg(ctx);
  return [[], ''];
}

/**
 * @param {string} head
 * @returns {{ callee: string, receiver: string, collection: string }}
 */
function parseCallHead(head) {
  const db = head.match(/storage\.db\[(['"])([^'"]+)\1\]\.([A-Za-z0-9_]+)$/);
  if (db) {
    return { callee: db[3] || '', receiver: db[0] || '', collection: db[2] || '' };
  }
  const dotted = head.match(/([A-Za-z_$][A-Za-z0-9_.$]*)$/);
  if (dotted) {
    return { callee: dotted[1] || '', receiver: dotted[1] || '', collection: '' };
  }
  return { callee: '', receiver: '', collection: '' };
}

/**
 * @param {string} line
 * @returns {{ callee: string, receiver: string, collection: string, arg: string } | null}
 */
function findUnclosedCall(line) {
  /** @type {{ callee: string, receiver: string, collection: string, index: number }[]} */
  const stack = [];
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (c === '(') {
      const parsed = parseCallHead(line.slice(0, i));
      stack.push({
        callee: parsed.callee,
        receiver: parsed.receiver,
        collection: parsed.collection,
        index: i,
      });
      continue;
    }
    if (c === ')' && stack.length) stack.pop();
  }
  if (!stack.length) return null;
  const top = stack[stack.length - 1];
  return {
    callee: top.callee,
    receiver: top.receiver,
    collection: top.collection,
    arg: line.slice(top.index + 1),
  };
}

/**
 * @param {CompletionTree} tree
 * @param {string} callee
 * @returns {CompletionNode | null}
 */
function lookupCall(tree, callee) {
  if (!callee) return null;
  const parts = callee.split('.');
  /** @type {CompletionNode} */
  let node = tree;
  for (let i = 0; i < parts.length; i++) {
    if (!node || typeof node !== 'object') return null;
    const part = parts[i];
    const isLast = i === parts.length - 1;
    const key = part + (isLast ? '(' : '');
    if (Object.prototype.hasOwnProperty.call(node, key)) {
      node = node[key];
      continue;
    }
    if (isLast && Object.prototype.hasOwnProperty.call(node, part + '()')) {
      return node[part + '()'];
    }
    return null;
  }
  return node;
}

/**
 * @param {CompletionNode} child
 * @param {string} text
 * @param {string} name
 * @returns {import("readline").CompleterResult}
 */
function finishExact(child, text, name) {
  if (isPathCompleter(child)) {
    return child(text) ?? [[], ''];
  }
  if (child && typeof child === 'object') {
    const keys = Object.keys(child).map((k) => `${name}.${k}`);
    return [keys, name];
  }
  return [[], ''];
}

/**
 * help() and print() take sandbox values, so their arguments complete as paths.
 * At the root of help()/print(), prefer namespaces over commands.
 * @param {string} arg
 * @param {CompletionTree} tree
 * @returns {import("readline").CompleterResult}
 */
function completeValueArg(arg, tree) {
  const trimmed = arg.trimStart();
  const [completions, prefix] = completePath(trimmed, tree);
  if (!trimmed.includes('.')) {
    const objects = completions.filter((c) => !c.includes('('));
    if (objects.length) return [objects, prefix];
  }
  return [completions, prefix];
}

/**
 * @param {string} text
 * @param {CompletionTree} root
 * @returns {import("readline").CompleterResult}
 */
function completePath(text, root) {
  if (!text) {
    return [Object.keys(root), ''];
  }

  const parts = text.endsWith('.')
    ? text.slice(0, -1).split('.').concat([''])
    : text.split('.');

  /** @type {CompletionNode} */
  let node = root;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;

    if (isPathCompleter(node)) {
      return node(text) ?? [[], ''];
    }
    if (isArgCompleter(node) || !node || typeof node !== 'object') {
      return [[], ''];
    }
    // Copy into a const so the object narrowing holds inside callbacks.
    const tree = /** @type {CompletionTree} */ (node);

    if (!isLast) {
      if (part && Object.prototype.hasOwnProperty.call(tree, part)) {
        node = tree[part];
        continue;
      }
      const dynKey = Object.keys(tree).find((k) => {
        return isPathCompleter(tree[k]) && part.startsWith(k);
      });
      if (dynKey) {
        const child = tree[dynKey];
        if (isPathCompleter(child)) {
          return child(text) ?? [[], ''];
        }
      }
      return [[], ''];
    }

    if (Object.prototype.hasOwnProperty.call(tree, part)) {
      return finishExact(tree[part], text, part);
    }

    const bare = part.replace(/[^A-Za-z0-9_$].*$/, '');
    if (bare !== part && Object.prototype.hasOwnProperty.call(tree, bare)) {
      return finishExact(tree[bare], text, bare);
    }

    const keys = Object.keys(tree).filter((k) => k.startsWith(part));
    if (keys.length === 1 && keys[0] === part) {
      return [[], ''];
    }
    if (keys.length) {
      return [keys, part];
    }
    return [[], ''];
  }

  return [[], ''];
}

/**
 * @param {string} line
 * @param {CompletionTree} tree
 * @param {CompletionCatalog} catalog
 * @returns {import("readline").CompleterResult}
 */
function completeLine(line, tree, catalog) {
  const call = findUnclosedCall(line);
  if (call) {
    /** @type {ArgContext} */
    const ctx = {
      line,
      callee: call.callee,
      receiver: call.receiver,
      arg: call.arg,
      collection: call.collection,
      catalog,
    };
    if (call.collection) return completeDbCall(ctx);
    if (VALUE_ARG_FUNCTIONS.has(call.callee)) return completeValueArg(call.arg, tree);
    const node = lookupCall(tree, call.callee);
    if (isArgCompleter(node)) return node(ctx) ?? [[], ''];
    return [[], ''];
  }

  const tokenMatch = line.match(/([A-Za-z0-9_.$()[\]'"]+\.?)$/);
  if (!tokenMatch) {
    return [Object.keys(tree), ''];
  }
  return completePath(tokenMatch[1] || '', tree);
}

/**
 * Which value list a field reads. `null` means this field has no value completion.
 * @param {string} collection
 * @param {string} field
 * @returns {keyof CompletionCatalog['values'] | null}
 */
function valueKind(collection, field) {
  if (field === '_id') {
    if (collection === 'users') return 'userId';
    if (collection === 'rooms') return 'room';
    return null;
  }
  return FIELD_KINDS[field] || null;
}

/**
 * Sync sandbox expression. The server sends `"" + result` with no inspect cap.
 * @param {string} id
 * @param {string} expr
 * @returns {string}
 */
function syncSnippet(id, expr) {
  return `'@@c:'+JSON.stringify({id:${JSON.stringify(id)},data:(${expr})})`;
}

/**
 * Promise snippet. Resolves to `@@c:ready:<id>` after stashing the payload,
 * because a resolved value would be passed through `util.inspect`.
 * `compute` is statements that return the data (a value or a promise).
 * @param {string} id
 * @param {string} compute
 * @returns {string}
 */
function asyncSnippet(id, compute) {
  const prop = JSON.stringify('__c' + id);
  const ready = JSON.stringify('@@c:ready:' + id);
  const idJson = JSON.stringify(id);
  return `(function () {
    function finish(data) {
      globalThis[${prop}] = '@@c:' + JSON.stringify({ id: ${idJson}, data: data });
      return ${ready};
    }
    return Promise.resolve().then(function () {
      ${compute}
    }).then(finish, function () { return finish([]); });
  })()`;
}

/**
 * @param {string} collection
 * @returns {CatalogQuery}
 */
function fieldsQuery(collection) {
  const name = JSON.stringify(collection);
  const id = `fields:${collection}`;
  return {
    id,
    async: true,
    source: asyncSnippet(id, `
      return storage.db[${name}].find({}, {}, { limit: 30 }).then(function (docs) {
        var keys = Object.create(null);
        if (!Array.isArray(docs)) docs = [];
        for (var i = 0; i < docs.length; i++) {
          var row = docs[i];
          if (!row || typeof row !== 'object') continue;
          var ks = Object.keys(row);
          for (var k = 0; k < ks.length; k++) keys[ks[k]] = 1;
        }
        return Object.keys(keys);
      });
    `),
  };
}

/**
 * @param {keyof CompletionCatalog['values']} kind
 * @returns {CatalogQuery}
 */
function valuesQuery(kind) {
  /** @type {Record<string, { collection: string, field: string, limit: number }>} */
  const specs = {
    username: { collection: 'users', field: 'username', limit: CATALOG_VALUE_CAP },
    email: { collection: 'users', field: 'email', limit: CATALOG_VALUE_CAP },
    userId: { collection: 'users', field: '_id', limit: CATALOG_VALUE_CAP },
    room: { collection: 'rooms', field: '_id', limit: CATALOG_VALUE_CAP },
    type: { collection: 'rooms.objects', field: 'type', limit: 2000 },
  };
  const spec = specs[kind];
  const id = `values:${kind}`;
  if (!spec) {
    return { id, async: true, source: asyncSnippet(id, 'return [];') };
  }
  const collection = JSON.stringify(spec.collection);
  const field = JSON.stringify(spec.field);
  const cap = Math.min(spec.limit, CATALOG_VALUE_CAP);
  return {
    id,
    async: true,
    source: asyncSnippet(id, `
      return storage.db[${collection}].find({}, { ${field}: 1 }, { limit: ${spec.limit} }).then(function (docs) {
        var out = [];
        var seen = Object.create(null);
        if (!Array.isArray(docs)) return out;
        for (var i = 0; i < docs.length && out.length < ${cap}; i++) {
          var doc = docs[i];
          if (!doc) continue;
          var v = doc[${field}];
          if (v == null || v === '') continue;
          var s = String(v);
          if (seen[s]) continue;
          seen[s] = 1;
          out.push(s);
        }
        return out;
      });
    `),
  };
}

/**
 * Snippets the completer still needs before `line` can be completed.
 * Already-loaded slices are skipped.
 * @param {string} line
 * @param {CompletionCatalog} catalog
 * @returns {CatalogQuery[]}
 */
function catalogRequests(line, catalog) {
  /** @type {CatalogQuery[]} */
  const queries = [];
  if (line.includes('storage.env.keys') && catalog.envKeys == null) {
    queries.push({
      id: 'envKeys',
      async: false,
      source: syncSnippet('envKeys', 'Object.keys(storage.env.keys)'),
    });
  }
  if (line.includes('storage.pubsub.keys') && catalog.pubsubKeys == null) {
    queries.push({
      id: 'pubsubKeys',
      async: false,
      source: syncSnippet('pubsubKeys', 'Object.keys(storage.pubsub.keys)'),
    });
  }
  if (/storage\.db\[(['"])[^'"]*$/.test(line) && !collectionsKnown(catalog)) {
    queries.push({
      id: 'collections',
      async: false,
      source: syncSnippet('collections', 'Object.keys(storage.db)'),
    });
  }

  const call = findUnclosedCall(line);
  if (call && call.collection) {
    const fieldsLoaded = catalog.fields[call.collection] != null;
    if (call.callee === 'ensureIndex' && !fieldsLoaded) {
      queries.push(fieldsQuery(call.collection));
    } else if (QUERY_METHODS.has(call.callee)) {
      const pos = scanObjectArg(call.arg);
      if (pos && pos.kind === 'key' && !fieldsLoaded) {
        queries.push(fieldsQuery(call.collection));
      }
      if (pos && pos.kind === 'value') {
        const kind = valueKind(call.collection, pos.field);
        if (kind && catalog.values[kind] == null) queries.push(valuesQuery(kind));
      }
    }
  }
  return queries;
}

/**
 * Follow-up for an async query: return the stashed payload as a raw string.
 * @param {string} id
 * @returns {string}
 */
function readStashSnippet(id) {
  const prop = JSON.stringify('__c' + id);
  return `(function () { var c = globalThis[${prop}]; delete globalThis[${prop}]; return c; })()`;
}

/**
 * Undo one layer of `util.inspect` quoting around a short token.
 * @param {string} body
 * @returns {string}
 */
function unquoteInspect(body) {
  if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) {
    return body.slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return body;
    }
  }
  return body;
}

/**
 * @param {string} body
 * @returns {{ ready: string } | { id: string, data: unknown } | null}
 */
function parseCatalogResult(body) {
  const text = unquoteInspect(body);
  if (!text.startsWith('@@c:')) return null;
  const rest = text.slice(4);
  if (rest.startsWith('ready:')) return { ready: rest.slice('ready:'.length) };
  try {
    const payload = JSON.parse(rest);
    if (!payload || typeof payload !== 'object' || typeof payload.id !== 'string') return null;
    return { id: payload.id, data: payload.data };
  } catch {
    return null;
  }
}

/**
 * @param {CompletionCatalog} catalog
 * @param {{ id: string, data: unknown }} slice
 */
function applyCatalogSlice(catalog, slice) {
  const data = asStringList(slice.data);
  if (slice.id === 'envKeys') catalog.envKeys = data;
  else if (slice.id === 'pubsubKeys') catalog.pubsubKeys = data;
  else if (slice.id === 'collections') catalog.collections = data;
  else if (slice.id.startsWith('fields:')) catalog.fields[slice.id.slice('fields:'.length)] = data;
  else if (slice.id.startsWith('values:')) {
    const kind = slice.id.slice('values:'.length);
    if (kind === 'username' || kind === 'usernameLower' || kind === 'email' || kind === 'userId' || kind === 'room' || kind === 'type') {
      catalog.values[kind] = data;
    }
  }
}

/**
 * @param {unknown} [catalog]
 * @returns {ScreepsCompleter}
 */
function createCompleter(catalog) {
  const normalized = normalizeCatalog(catalog);
  /**
   * @param {string} line
   * @returns {import("readline").CompleterResult}
   */
  const screepsCompleter = (line) => completeLine(line, buildTree(normalized), normalized);
  return Object.assign(screepsCompleter, { catalog: normalized });
}

module.exports = {
  createCompleter,
  emptyCatalog,
  catalogRequests,
  applyCatalogSlice,
  readStashSnippet,
  parseCatalogResult,
};
