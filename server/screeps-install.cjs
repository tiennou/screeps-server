#! /usr/bin/env node
// @ts-ignore We can't load that from the outer non-Node 10 side
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { execSync } = require("child_process");

const RootDir = process.env["SERVER_DIR"];
if (!RootDir) {
  throw new Error("Missing environment variable $SERVER_DIR");
}
const ModsDir = path.join(RootDir, "mods");
const ConfigPath = path.join(RootDir, "config.yml");

process.chdir(RootDir);

const config = /** @type {Config} */ (yaml.load(fs.readFileSync(ConfigPath, "utf8")));


/** @type {(keyof LauncherOptions["custom"])[]} */
const SERVER_PARTS = ["backend", "common", "driver", "engine", "isolatedVM", "launcher", "pathfinding", "screeps", "storage"];

const start = async () => {
  const { custom: customServer } = config.launcherOptions;
  if (!customServer) return;
  for (const part of SERVER_PARTS) {
    if (!customServer[part]) continue;
    let installPath = customServer[part];

    if (part === "engine") {
      // Engine is a special snowflake; it needs to be `gulp`ed beforehand
      const [repo, branch] = installPath.split("#");
      const installDir = path.basename(repo);
      console.log(`Preparing custom ${part} from ${customServer[part]} in ${installDir}`);
      execSync(`git clone ${repo}`, {
        cwd: RootDir,
        stdio: "inherit",
        encoding: 'utf8',
      });
      execSync(`git switch ${branch}`, {
        cwd: installDir,
        stdio: "inherit",
        encoding: 'utf8',
      });
      execSync(`npm clean-install`, {
        cwd: installDir,
        stdio: "inherit",
        encoding: 'utf8',
      });
      execSync(`npm run prepublish`, {
        cwd: installDir,
        stdio: "inherit",
        encoding: 'utf8',
      });
      installPath = installDir;
    }

    console.log(`Installing custom ${part} from ${customServer[part]}`);
    execSync(
      `npm install --logevel=error --no-progress ${installPath}`,
      {
        cwd: RootDir,
        stdio: "inherit",
        encoding: "utf8",
      },
    );
  }
}

start().catch((err) => {
  console.error(err.message);
  process.exit();
});
