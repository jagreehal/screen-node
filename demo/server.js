// Tiny server to demo port publishing + hot reload.
//   ../sandbox run -- node server.js     (run.ports maps 8077 -> host)
// then open http://localhost:8077 on the host. Edit this file and restart to
// see changes (or wrap with a watcher for hot reload).
const http = require('http');
const os = require('os');
http
  .createServer((_req, res) => res.end(`hello from sandbox container ${os.hostname()}\n`))
  .listen(8077, () => console.log('listening on 8077 (published to host:8077)'));
