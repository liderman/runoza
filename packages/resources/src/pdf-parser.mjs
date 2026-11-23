// Runs in a short-lived Node process with bounded input, heap and read permissions.
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";
// PDF.js emits optional rendering diagnostics on stdout; reserve stdout for the wire format.
console.log = console.warn = () => {};
const assets = dirname(dirname(dirname(process.argv[2])));
const { getDocument } = await import(pathToFileURL(process.argv[2]).href);
const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 64 * 1024 * 1024) throw Error("PDF_LIMIT");
  chunks.push(chunk);
}
const input = new Uint8Array(Buffer.concat(chunks));
const loading = getDocument({
  data: input,
  cMapUrl: join(assets, "cmaps") + sep,
  cMapPacked: true,
  standardFontDataUrl: join(assets, "standard_fonts") + sep,
  useWasm: false,
  useWorkerFetch: false,
  disableFontFace: true,
  isOffscreenCanvasSupported: false,
  verbosity: 0,
});
try {
  const doc = await loading.promise;
  if (doc.numPages > 1000) throw Error("PDF_LIMIT");
  const pages = [];
  let total = 0;
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n),
      reader = page.streamTextContent().getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const item of value.items) {
        if (typeof item.str !== "string") continue;
        const part =
          item.str.replaceAll("\u0000", "") + (item.hasEOL ? "\n" : " ");
        total += part.length;
        if (total > 1000000) throw Error("PDF_LIMIT");
        text += part;
      }
    }
    pages.push(text);
    page.cleanup();
  }
  process.stdout.write(JSON.stringify(pages));
} catch {
  process.exitCode = 1;
} finally {
  await loading.destroy();
}
