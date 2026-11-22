// Public HTTP(S) only. Sandboxes retain internal Docker networks.
import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import { pathToFileURL } from "node:url";
export function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}
async function publicAddresses(host, port, lookup = dns.lookup) {
  if (![80, 443].includes(port) || !host || host.includes("%"))
    throw Error("DENIED");
  const addresses = await lookup(host, { all: true, family: 4 });
  if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
    throw Error("DENIED");
  return addresses.map(({ address }) => ({ address, family: 4 }));
}
export async function destination(host, port, lookup = dns.lookup) {
  return (await publicAddresses(host, port, lookup))[0].address;
}
export async function connectionOptions(host, port, lookup = dns.lookup) {
  const addresses = await publicAddresses(host, port, lookup);
  return {
    host,
    port,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    // Reuse only the checked DNS answer, including when Node tries another IP.
    lookup: (_host, options, callback) =>
      queueMicrotask(() => {
        if (options?.all) callback(null, addresses);
        else callback(null, addresses[0].address, 4);
      }),
  };
}
export function createProxy() {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url);
      if (u.protocol !== "http:" || u.username || u.password)
        throw Error("DENIED");
      const port = Number(u.port || 80),
        connection = await connectionOptions(u.hostname, port);
      const headers = { ...req.headers, host: u.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = http.request(
        {
          ...connection,
          method: req.method,
          path: u.pathname + u.search,
          headers,
          timeout: 60000,
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          let bytes = 0;
          r.on("data", (b) => {
            bytes += b.length;
            if (bytes > 134217728) {
              r.destroy();
              res.destroy();
            }
          });
          r.pipe(res);
        },
      );
      upstream.on("timeout", () => upstream.destroy());
      upstream.on("error", () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    } catch {
      res.writeHead(403);
      res.end("Destination blocked");
    }
  });
  server.on("connect", async (req, client, head) => {
    try {
      const u = new URL("http://" + req.url);
      if (u.username || u.password || u.pathname !== "/") throw Error("DENIED");
      const port = Number(u.port || 443),
        connection = await connectionOptions(u.hostname, port);
      const upstream = net.connect(connection, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      let bytes = 0;
      upstream.on("data", (b) => {
        bytes += b.length;
        if (bytes > 134217728) upstream.destroy();
      });
      upstream.setTimeout(60000, () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => client.destroy());
      client.on("error", () => upstream.destroy());
      client.on("close", () => upstream.destroy());
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  server.on("clientError", (_e, socket) =>
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"),
  );
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  createProxy().listen(8080, "0.0.0.0");
