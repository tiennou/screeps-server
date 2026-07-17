Edit `config.yml` to add mods and bots. Some mods also look there for configuration.
The mods and bots are installed using `npm install`, thus you can use anything that it recognizes as [a valid package](https://docs.npmjs.com/cli/v6/commands/npm-install).

### Defaults
We currently add the following mods, as default:

- [screepsmod-auth](https://github.com/ScreepsMods/screepsmod-auth)
- [screepsmod-admin-utils](https://github.com/ScreepsMods/screepsmod-admin-utils)
- [screepsmod-mongo](https://github.com/ScreepsMods/screepsmod-mongo)

### Mods
Mods are managed by changing the `mods` YAML list in `config.yml`.
Here is an example where we remove `mongo` and add `cli`
```diff
mods:
  - screepsmod-auth
  - screepsmod-admin-utils
-  - screepsmod-mongo
+  - screepsmod-cli
```

### Bots
Bots are managed by changing the `bots` object in `config.yml`. The key is the name you wish to use for the bot; the value is an npm package name or a local path.
```diff
bots:
-  simplebot: screepsbot-zeswarm
+  zeswarm: screepsbot-zeswarm
+  quorum: screepsbot-quorum
```

You can set the value to either a folder with either a `package.json` file that defines `"main"` or a `main.js` file containing the bot's source code, or an explicit path to `main.js`; the reason is that the Screeps server is hardcoded to look for a `main.js` file.

### Server options
We can set options specific to the server. Here is an example that forwards log messages to the terminal.
```diff
serverOptions:
-  logConsole: false
+  logConsole: true
```