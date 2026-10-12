// Copies the CAD viewer's workers and the DWG reader (WebAssembly) into public/cad/, where the browser
// loads them the first time someone opens a drawing. Runs before dev and build; public/cad is not committed.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const dir = (pkg) => join(root, "node_modules", pkg); // the packages don't export package.json
const out = join(root, "public", "cad");
mkdirSync(out, { recursive: true });
const files = [
  [dir("@mlightcad/cad-simple-viewer"), "dist/mtext-renderer-worker.js"],
  [dir("@mlightcad/libredwg-converter"), "dist/libredwg-parser-worker.js"],
  [dir("@mlightcad/libredwg-converter"), "dist/libredwg-web.wasm"],
];
for (const [from, file] of files) copyFileSync(join(from, file), join(out, file.split("/").pop()));
console.log(`CAD viewer assets copied to public/cad (${files.length} files)`);
