// bun prototypes/serve.ts — serves the prototype gallery at http://localhost:4600
import { join, normalize } from "node:path";

const root = import.meta.dir;

const server = Bun.serve({
  port: 4600,
  async fetch(req) {
    const pathname = decodeURIComponent(new URL(req.url).pathname);
    let rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^\/+/, "");
    if (rel.startsWith("..")) return new Response("forbidden", { status: 403 });
    if (rel.endsWith("/")) rel += "index.html";
    let file = Bun.file(join(root, rel));
    if (!(await file.exists())) {
      file = Bun.file(join(root, rel, "index.html"));
      if (!(await file.exists())) return new Response("not found", { status: 404 });
    }
    return new Response(file);
  },
});

console.log(`prototypes → http://localhost:${server.port}`);
