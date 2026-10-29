import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// `pelican` loads the command line first and the menu, whose React must be
// the production build, only when it opens. NODE_ENV is set for that just
// before the menu loads, so anything the command line imports on its way in
// that loads React would pin the development build for the menu too (a
// development React under a production Ink: a black screen). The other tests
// never set NODE_ENV, so every build is the development one and none of them
// would notice. This one loads in the order the program does.
test("loading the command line leaves React to the menu, which gets the production build", () => {
  const cli = new URL("../src/cli.js", import.meta.url).href;
  const react = pathToFileURL(
    createRequire(import.meta.url).resolve("react"),
  ).href;
  const script = `
    await import(process.argv[1]);
    process.env.NODE_ENV ??= "production";
    const react = await import(process.argv[2]);
    const development = [react, react.default].some(
      (r) => typeof r?.captureOwnerStack === "function",
    );
    process.stdout.write(development ? "development" : "production");
  `;
  const env = { ...process.env };
  delete env.NODE_ENV;
  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, cli, react],
    { env, encoding: "utf8", timeout: 30000 },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, "production");
});
