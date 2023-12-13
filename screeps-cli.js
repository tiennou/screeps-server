#! /usr/bin/env node
const screeps = require("@screeps/launcher");
const repl = require("repl");
const q = require('q');
const net = require("net");
const path = require('path');
const os = require('os');
const fs = require('fs');

cli("localhost", 21026);

function cli(host, port) {
  
  const defer = q.defer();
  
  /**
  * @param {string} cmd 
  * @param {Context} context 
  * @param {string} file 
  * @param {(err: Error | null, result: any) => void} cb 
  */
  const rplEval = (cmd, context, file, callback) => {
    let result;
    try {
      result = socket.write(cmd);
    } catch (e) {
      if (isRecoverableError(e)) {
        return callback(new repl.Recoverable(e));
      }
    }
    callback(null, result);
  }
  
  function isRecoverableError(error) {
    if (error.name === 'SyntaxError') {
      return /^(Unexpected end of input|Unexpected token)/.test(error.message);
    }
    return false;
  }
  
  const rl = repl.start({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
    eval: rplEval,
  });

  const historyFile = path.join(os.homedir(), '.screeps-history');
  try {
    rl.history = JSON.parse(fs.readFileSync(historyFile));
  } catch (err) {}

  rl.on('close', () => {
    fs.writeFileSync(historyFile, JSON.stringify(rl.history));
  });
  
  rl.on('line', (line) => {
    process.stdout.write(`socket write: ${line}\n`);
    socket.write(line+"\r\n");
    rl.prompt();
  });

  const socket = net.connect(port, host);
  
  socket.on('connect', () => {
    defer.resolve();
    rl.output.write(`Screeps CLI connected on ${host}:${port}.\r\n-----------------------------------------\r\n`);
  });

  socket.on('data', (data) => {
    data = data.toString('utf8');
    process.stdout.write(`socket read: ${data}\n`);
    rl.output.write(data.replace(/^< /, '').replace(/\n< /, ''));
    if(/^< /.test(data) || /\n< /.test(data)) {
      rl.prompt();
    }
  });
  
  socket.on('error', (error) => {
    defer.reject(error);
  });
  
  return defer.promise;
};


// const rl = readline.createInterface({
//   input: process.stdin,
//   output: process.stdout,
//   prompt: "> ",
// });

// screeps.cli("localhost", 21026, rl);
