#! /usr/bin/env node
const screeps = require("@screeps/launcher");
const readline = require("readline");
const repl = require("repl");

const rl = repl.start({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

// const rl = readline.createInterface({
//   input: process.stdin,
//   output: process.stdout,
//   prompt: "> ",
// });

screeps.cli("localhost", 21026, rl);
