const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  createCompleter,
  emptyCatalog,
  catalogRequests,
  applyCatalogSlice,
  readStashSnippet,
  parseCatalogResult,
} = require('./screeps-completer.cjs');

const ENV_KEYS = [
  'ACCESSIBLE_ROOMS',
  'ROOM_STATUS_DATA',
  'MEMORY',
  'GAMETIME',
  'MAP_VIEW',
  'TERRAIN_DATA',
  'SCRIPT_CACHED_DATA',
  'USER_ONLINE',
  'MAIN_LOOP_PAUSED',
  'ROOM_HISTORY',
  'ROOM_VISUAL',
  'MEMORY_SEGMENTS',
  'PUBLIC_MEMORY_SEGMENTS',
  'ROOM_EVENT_LOG',
  'ACTIVE_ROOMS',
  'MAIN_LOOP_MIN_DURATION',
  'SHARD_NAME',
  'TICK_RATE',
  'TICK_TIMING',
  'SOCKET_UPDATE_RATE',
  'LAST_TICKS',
  'MAP_URL',
  'WHITELIST',
  'BANNED_IDENTITIES',
  'ROOM_INTENTS',
  'DATABASE_VERSION',
  'DATABASE_READY',
  'STATUS_DATA',
  'ONLY_ON_FIXTURE',
];

const PUBSUB_KEYS = [
  'QUEUE_DONE',
  'RUNTIME_RESTART',
  'TICK_STARTED',
  'ROOMS_DONE',
];

const COLLECTION_NAMES = [
  'leaderboard.power',
  'leaderboard.seasons',
  'leaderboard.world',
  'users.intents',
  'market.orders',
  'market.stats',
  'market.intents',
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
  'users.tokens',
  'only.here',
];

/** @type {Record<string, string[]>} */
const fields = Object.fromEntries(COLLECTION_NAMES.map((name) => [name, []]));
fields.users = ['username', 'email', '_id', 'cpu'];
fields.rooms = ['_id', 'status'];
fields['rooms.objects'] = ['room', 'user', 'type', '_id'];
fields['users.messages'] = ['user', 'message'];
fields['only.here'] = ['customField'];

const completer = createCompleter({
  envKeys: ENV_KEYS,
  pubsubKeys: PUBSUB_KEYS,
  fields,
  values: {
    username: ['Tiennou', 'Alice'],
    usernameLower: ['tiennou', 'alice'],
    email: ['tiennou@example.com'],
    userId: ['abc123', 'def456'],
    room: ['W1N1', 'W2N2'],
    type: ['creep', 'spawn'],
  },
});

/**
 * @param {string} line
 */
function complete(line) {
  const result = completer(line);
  assert.equal(result.length, 2);
  const [completions, prefix] = result;
  assert.ok(Array.isArray(completions));
  assert.equal(typeof prefix, 'string');
  assert.ok(
    line.endsWith(prefix),
    `prefix ${JSON.stringify(prefix)} is not a suffix of ${JSON.stringify(line)}`,
  );
  return { completions, prefix };
}

/**
 * @param {string[]} actual
 * @param {string[]} expected
 */
function sameMembers(actual, expected) {
  assert.deepEqual([...actual].sort(), [...expected].sort());
}

test('empty input lists every root command', () => {
  const { completions, prefix } = complete('');
  assert.equal(prefix, '');
  sameMembers(completions, [
    'help(',
    'print(',
    'storage',
    'map',
    'bots',
    'strongholds',
    'system',
    'utils',
    'auth',
    'mongo',
  ]);
});

test('a shared prefix narrows root commands', () => {
  const stor = complete('st');
  assert.equal(stor.prefix, 'st');
  sameMembers(stor.completions, ['storage', 'strongholds']);

  const sys = complete('sy');
  assert.equal(sys.prefix, 'sy');
  sameMembers(sys.completions, ['system']);
});

test('an exact namespace offers its members', () => {
  const { completions, prefix } = complete('storage');
  assert.equal(prefix, 'storage');
  sameMembers(completions, [
    'storage.db',
    'storage.env',
    'storage.pubsub',
    'storage.queue',
  ]);
});

test('a trailing dot lists the next segment', () => {
  const { completions, prefix } = complete('storage.queue.');
  assert.equal(prefix, '');
  sameMembers(completions, [
    'fetch(',
    'add(',
    'addMulti(',
    'markDone(',
    'whenAllDone(',
    'reset(',
  ]);
});

test('storage.db completes collection access', () => {
  const opened = complete('storage.db');
  assert.deepEqual(opened.completions, ["storage.db['"]);
  assert.equal(opened.prefix, 'storage.db');

  const dotted = complete('storage.db.');
  assert.deepEqual(dotted.completions, ["['"]);
  assert.equal(dotted.prefix, '');

  const rooms = complete("storage.db['rooms");
  assert.equal(rooms.prefix, 'rooms');
  assert.ok(rooms.completions.includes("rooms']"));
  assert.ok(rooms.completions.includes("rooms.objects']"));
  assert.ok(rooms.completions.includes("rooms.flags']"));

  const quoted = complete('storage.db["users.to');
  assert.equal(quoted.prefix, 'users.to');
  assert.deepEqual(quoted.completions, ['users.tokens"]']);

  const ready = complete("storage.db['rooms.objects']");
  assert.deepEqual(ready.completions, ['.']);
  assert.equal(ready.prefix, '');

  const methods = complete("storage.db['rooms.objects'].f");
  assert.equal(methods.prefix, 'f');
  sameMembers(methods.completions, ['find(', 'findOne(', 'findEx(']);
});

test('zero-arg commands complete the call and then stop', () => {
  const partial = complete('system.resetAll');
  assert.deepEqual(partial.completions, ['resetAllData()']);
  assert.equal(partial.prefix, 'resetAll');

  const done = complete('system.resetAllData()');
  assert.deepEqual(done.completions, []);

  const tick = complete('system.getTick');
  assert.deepEqual(tick.completions, ['getTickDuration()']);

  const listed = complete('system.list');
  assert.deepEqual(listed.completions, ['listCronjobs()']);

  const bots = complete('utils.removeB');
  assert.deepEqual(bots.completions, ['removeBots()']);

  const whitelist = complete('utils.getW');
  assert.deepEqual(whitelist.completions, ['getWhitelist()']);

  const reload = complete('utils.reload');
  assert.deepEqual(reload.completions, ['reloadConfig()']);
});

test('commands that take arguments complete through the opening paren', () => {
  const { completions, prefix } = complete('map.update');
  assert.equal(prefix, 'update');
  sameMembers(completions, ['updateRoomImageAssets(', 'updateTerrainData()']);

  assert.deepEqual(complete('bots.sp').completions, ['spawn(']);
  assert.deepEqual(complete('strongholds.e').completions, ['expand(']);
  assert.deepEqual(complete('auth.list').completions, ['listUserTokenRateLimits(']);
  assert.deepEqual(complete('mongo.').completions, ['importDB(']);
});

test('help() and print() complete namespaces, then paths inside them', () => {
  const help = complete('help(');
  assert.equal(help.prefix, '');
  sameMembers(help.completions, [
    'storage',
    'map',
    'bots',
    'strongholds',
    'system',
    'utils',
    'auth',
    'mongo',
  ]);

  const narrowed = complete('help(st');
  assert.equal(narrowed.prefix, 'st');
  sameMembers(narrowed.completions, ['storage', 'strongholds']);

  const system = complete('help(sy');
  assert.equal(system.prefix, 'sy');
  sameMembers(system.completions, ['system']);

  const inside = complete('print( storage.');
  assert.equal(inside.prefix, '');
  sameMembers(inside.completions, ['db', 'env', 'pubsub', 'queue']);

  const method = complete('help(system.re');
  assert.equal(method.prefix, 're');
  sameMembers(method.completions, ['resetAllData()', 'resumeSimulation()']);
});

test('env and pubsub calls complete key constants', () => {
  const env = complete('storage.env.get(');
  assert.deepEqual(env.completions, ['storage.env.keys.']);
  assert.equal(env.prefix, '');

  const partialRef = complete('storage.env.set(sto');
  assert.deepEqual(partialRef.completions, ['storage.env.keys.']);
  assert.equal(partialRef.prefix, 'sto');

  const names = complete('storage.env.get(storage.env.keys.GA');
  assert.equal(names.prefix, 'GA');
  assert.deepEqual(names.completions, ['GAMETIME']);

  const modKey = complete('storage.pubsub.once(storage.pubsub.keys.');
  assert.equal(modKey.prefix, '');
  sameMembers(modKey.completions, [
    'QUEUE_DONE',
    'RUNTIME_RESTART',
    'TICK_STARTED',
    'ROOMS_DONE',
  ]);

  const hash = complete('storage.env.hg');
  assert.equal(hash.prefix, 'hg');
  sameMembers(hash.completions, ['hget(', 'hgetall(']);
});

test('runCronjob completes known cronjob names as strings', () => {
  const opened = complete('system.runCronjob(');
  assert.equal(opened.prefix, '');
  assert.ok(opened.completions.includes("'genStrongholds'"));
  assert.ok(opened.completions.includes("'authUpdates'"));
  assert.ok(opened.completions.includes("'stats'"));

  const partial = complete("system.runCronjob('genS");
  assert.equal(partial.prefix, 'genS');
  assert.deepEqual(partial.completions, ["genStrongholds'"]);

  const unquoted = complete('system.runCronjob(stats');
  assert.equal(unquoted.prefix, 'stats');
  assert.deepEqual(unquoted.completions, ["'stats'"]);

  const finished = complete("system.runCronjob('stats')");
  assert.deepEqual(finished.completions, []);
});

test('a call with no static arguments does not repeat the command', () => {
  assert.deepEqual(complete('bots.spawn(').completions, []);
  assert.deepEqual(complete('auth.setPassword(').completions, []);
  assert.deepEqual(complete('mongo.importDB(').completions, []);
});

test('unrelated text does not throw', () => {
  sameMembers(complete('!!!').completions, complete('').completions);
  assert.deepEqual(complete('(').completions, []);
});

test('env keys and collections come from the catalog', () => {
  const key = complete('storage.env.get(storage.env.keys.ONLY');
  assert.equal(key.prefix, 'ONLY');
  assert.deepEqual(key.completions, ['ONLY_ON_FIXTURE']);

  assert.deepEqual(complete('storage.env.get(storage.env.keys.NOT_REAL').completions, []);

  const collection = complete("storage.db['only");
  assert.equal(collection.prefix, 'only');
  assert.deepEqual(collection.completions, ["only.here']"]);

  assert.deepEqual(complete("storage.db['nope").completions, []);
});

test('find completes fields from that collection', () => {
  const users = complete("storage.db['users'].find({");
  assert.equal(users.prefix, '');
  sameMembers(users.completions, ['username: ', 'email: ', '_id: ', 'cpu: ']);
  assert.ok(!users.completions.some((item) => item.startsWith('status')));

  const rooms = complete("storage.db['rooms'].find({");
  assert.equal(rooms.prefix, '');
  sameMembers(rooms.completions, ['_id: ', 'status: ']);
  assert.ok(!rooms.completions.some((item) => item.startsWith('username')));

  const partial = complete("storage.db['users'].find({ user");
  assert.equal(partial.prefix, 'user');
  assert.deepEqual(partial.completions, ['username: ']);

  const custom = complete("storage.db['only.here'].find({");
  assert.deepEqual(custom.completions, ['customField: ']);
});

test('find completes mapped values for a field', () => {
  const name = complete("storage.db['users'].find({ username: 'Ti");
  assert.equal(name.prefix, 'Ti');
  assert.deepEqual(name.completions, ["Tiennou'"]);

  const lower = complete("storage.db['users'].find({ usernameLower: 'Ti");
  assert.equal(lower.prefix, 'Ti');
  assert.deepEqual(lower.completions, ["Tiennou'"]);

  const ids = complete("storage.db['users.messages'].find({ user: ");
  assert.equal(ids.prefix, '');
  sameMembers(ids.completions, ["'abc123'", "'def456'"]);

  const userId = complete("storage.db['users'].find({ _id: 'ab");
  assert.equal(userId.prefix, 'ab');
  assert.deepEqual(userId.completions, ["abc123'"]);

  const rooms = complete("storage.db['rooms'].find({ _id: ");
  assert.equal(rooms.prefix, '');
  sameMembers(rooms.completions, ["'W1N1'", "'W2N2'"]);

  const objectId = complete("storage.db['rooms.objects'].find({ _id: ");
  assert.deepEqual(objectId.completions, []);

  const room = complete("storage.db['rooms.objects'].find({ room: 'W1");
  assert.equal(room.prefix, 'W1');
  assert.deepEqual(room.completions, ["W1N1'"]);

  const type = complete("storage.db['rooms.objects'].find({ type: 'c");
  assert.equal(type.prefix, 'c');
  assert.deepEqual(type.completions, ["creep'"]);

  assert.deepEqual(complete("storage.db['users'].find({ cpu: ").completions, []);
  assert.deepEqual(complete("storage.db['users'].find({ cpu: '1").completions, []);
});

test('a comma returns to field completion, and later objects are left alone', () => {
  const next = complete("storage.db['users'].find({ username: 'a', ");
  assert.equal(next.prefix, '');
  sameMembers(next.completions, ['username: ', 'email: ', '_id: ', 'cpu: ']);

  const afterNested = complete("storage.db['users'].find({ username: { $exists: true }, em");
  assert.equal(afterNested.prefix, 'em');
  assert.deepEqual(afterNested.completions, ['email: ']);

  assert.deepEqual(complete("storage.db['users'].find({ username: 'a' }, {").completions, []);
  assert.deepEqual(complete("storage.db['users'].find({ $or").completions, []);
});

test('ensureIndex completes the collection fields as strings', () => {
  const opened = complete("storage.db['users'].ensureIndex(");
  assert.equal(opened.prefix, '');
  assert.ok(opened.completions.includes("'username'"));
  assert.ok(opened.completions.includes("'cpu'"));

  const partial = complete("storage.db['users'].ensureIndex('us");
  assert.equal(partial.prefix, 'us');
  assert.deepEqual(partial.completions, ["username'"]);
});

test('a loaded catalog does not ask the server again', () => {
  assert.deepEqual(catalogRequests('storage.env.get(storage.env.keys.', completer.catalog), []);
  assert.deepEqual(catalogRequests("storage.db['users'].find({ username: 'Ti", completer.catalog), []);
  assert.deepEqual(catalogRequests("storage.db['", completer.catalog), []);
});

test('tab on a cold catalog asks only for the slice it needs', () => {
  const cold = emptyCatalog();
  assert.deepEqual(
    catalogRequests('storage.env.get(', cold).map((query) => query.id),
    [],
  );
  const env = catalogRequests('storage.env.get(storage.env.keys.', cold);
  assert.deepEqual(env.map((query) => query.id), ['envKeys']);
  assert.equal(env[0].async, false);
  assert.ok(env[0].source.length < 200);

  const names = catalogRequests("storage.db['us", cold);
  assert.deepEqual(names.map((query) => query.id), ['collections']);

  const keys = catalogRequests("storage.db['users'].find({", cold);
  assert.deepEqual(keys.map((query) => query.id), ['fields:users']);
  assert.equal(keys[0].async, true);

  const values = catalogRequests("storage.db['users'].find({ username: 'Ti", cold);
  assert.deepEqual(values.map((query) => query.id), ['values:username']);

  assert.deepEqual(catalogRequests("storage.db['users'].find({ cpu: ", cold), []);
});

test('snippets fill one slice and the completer picks it up', async () => {
  const live = createCompleter(emptyCatalog());
  /** @type {Record<string, any>} */
  const sandbox = {
    storage: {
      env: { keys: { GAMETIME: 'gameTime', ONLY_ON_FIXTURE: 'only' } },
      pubsub: { keys: { TICK_STARTED: 'tickStarted' } },
      db: {
        users: {
          /**
           * @param {object} _query
           * @param {{ username?: number }} [filter]
           * @returns {Promise<object[]>}
           */
          async find(_query, filter) {
            const docs = [
              { _id: 'id1', username: 'Tiennou', email: 'a@b.c', cpu: 1 },
              { _id: 'id2', username: 'Alice', email: '', cpu: 2 },
            ];
            if (filter && filter.username) return docs;
            return docs;
          },
        },
      },
    },
  };
  const context = vm.createContext(sandbox);

  const envQuery = catalogRequests('storage.env.keys.', live.catalog)[0];
  const envRaw = vm.runInContext(envQuery.source, context);
  const envParsed = parseCatalogResult(/** @type {string} */ (envRaw));
  assert.ok(envParsed && 'data' in envParsed);
  applyCatalogSlice(live.catalog, { id: envQuery.id, data: envParsed.data });
  const names = live('storage.env.get(storage.env.keys.');
  assert.equal(names[1], '');
  sameMembers(/** @type {string[]} */ (names[0]), ['GAMETIME', 'ONLY_ON_FIXTURE']);

  const fieldsQuery = catalogRequests("storage.db['users'].find({", live.catalog)[0];
  assert.ok(fieldsQuery.source.length < 1200);
  const ready = await vm.runInContext(fieldsQuery.source, context);
  assert.equal(ready, '@@c:ready:fields:users');
  assert.deepEqual(parseCatalogResult("'@@c:ready:fields:users'"), { ready: 'fields:users' });
  const stashed = vm.runInContext(readStashSnippet(fieldsQuery.id), context);
  const fieldsParsed = parseCatalogResult(/** @type {string} */ (stashed));
  assert.ok(fieldsParsed && 'data' in fieldsParsed);
  applyCatalogSlice(live.catalog, { id: fieldsQuery.id, data: fieldsParsed.data });
  assert.equal(sandbox['__cfields:users'], undefined);

  const fieldHits = live("storage.db['users'].find({ u");
  assert.equal(fieldHits[1], 'u');
  assert.deepEqual(fieldHits[0], ['username: ']);

  const valueQuery = catalogRequests("storage.db['users'].find({ username: '", live.catalog)[0];
  const valueReady = await vm.runInContext(valueQuery.source, context);
  assert.equal(valueReady, '@@c:ready:values:username');
  const valueRaw = vm.runInContext(readStashSnippet(valueQuery.id), context);
  const valueParsed = parseCatalogResult(/** @type {string} */ (valueRaw));
  assert.ok(valueParsed && 'data' in valueParsed);
  applyCatalogSlice(live.catalog, { id: valueQuery.id, data: valueParsed.data });
  const valueHits = live("storage.db['users'].find({ username: 'Ti");
  assert.deepEqual(valueHits[0], ["Tiennou'"]);
  assert.deepEqual(catalogRequests("storage.db['users'].find({ username: 'Ti", live.catalog), []);
});
