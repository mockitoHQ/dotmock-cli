import { fail, getState, onPath, run } from "./lib.mjs";

try {
  const port = getState("port");
  if (port && onPath("dotmock")) {
    const env = { ...process.env, DOTMOCK_STATE_DIR: getState("state_dir") || process.env.DOTMOCK_STATE_DIR };
    // Print the journal for debugging failed runs, then stop the server.
    try {
      const journal = run("curl", ["-fsS", `http://127.0.0.1:${port}/__dotmock/journal`]);
      const entries = JSON.parse(journal || "[]");
      console.log(`[dotmock] journal: ${Array.isArray(entries) ? entries.length : "?"} request(s)`);
    } catch {
      // server may already be gone
    }
    run("dotmock", ["serve", "stop", "--port", port], { env, stdio: ["ignore", "inherit", "inherit"] });
  }
} catch (error) {
  fail(error);
}
