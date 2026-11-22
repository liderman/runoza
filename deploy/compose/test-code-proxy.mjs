// Test-only transport into internal networks; upstream still authenticates every request.
import http from "node:http";
for (const [port, hostname] of [
  [8001, "terminal-a"],
  [8002, "terminal-b"],
])
  http
    .createServer((req, res) => {
      const upstream = http.request(
        {
          hostname,
          port: 8000,
          path: req.url,
          method: req.method,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      upstream.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    })
    .on("upgrade", (req, socket, head) => {
      const upstream = http.request({
        hostname,
        port: 8000,
        path: req.url,
        headers: req.headers,
      });
      upstream.on("upgrade", (res, remote, remoteHead) => {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            Object.entries(res.headers)
              .map(([k, v]) => k + ": " + v)
              .join("\r\n") +
            "\r\n\r\n",
        );
        if (remoteHead.length) socket.write(remoteHead);
        if (head.length) remote.write(head);
        remote.pipe(socket);
        socket.pipe(remote);
        socket.on("error", () => remote.destroy());
        remote.on("error", () => socket.destroy());
        socket.on("close", () => remote.destroy());
      });
      upstream.on("error", () => socket.destroy());
      upstream.end();
    })
    .listen(port, "0.0.0.0");
