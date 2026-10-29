import test from "node:test";
import assert from "node:assert/strict";
import { runMenu } from "../src/menu/index.js";
import { main } from "../src/cli.js";
import { harness, until } from "./helpers.js";
import { keys, RawInput, VirtualTerminal } from "./virtual-terminal.js";

function start(t, client, options = {}) {
  const input = new RawInput(),
    output = new VirtualTerminal(options.columns ?? 120, options.rows ?? 30);
  const done = runMenu({
    client,
    as: "menu",
    url: "http://127.0.0.1:4319",
    input,
    output,
    refreshMs: 40,
    color: false,
    glyphs: "rich",
    splash: false,
    ...options,
  });
  t.after(() => input.write(keys.ctrlC));
  const shows = (pattern, timeout = 8000) =>
    until(
      () =>
        typeof pattern === "string"
          ? output.text().includes(pattern)
          : pattern.test(output.text()),
      timeout,
    ).catch(() => {
      throw new Error("Missing " + pattern + "\n" + output.text());
    });
  const type = async (...list) => {
    for (const bytes of list) {
      input.write(bytes);
      await new Promise((resolve) =>
        setTimeout(resolve, bytes === keys.escape ? 120 : 25),
      );
    }
  };
  const click = async (text) => {
    const rows = output.text().split("\n"),
      y = rows.findIndex((row) => row.includes(text));
    assert.ok(y >= 0, text + "\n" + output.text());
    const x = rows[y].indexOf(text);
    await type("\x1b[<0;" + (x + 1) + ";" + (y + 1) + "M");
  };
  return { input, output, done, shows, type, click };
}

test(
  "context menus answer, take over, steer and stop agents while live content stays clickable",
  { timeout: 30000 },
  async (t) => {
    const { o, as, spec, workers, gateway, dir } = await harness(t),
      lead = as("lead");
    const job = await lead.spawn(
      spec("Login flake", { name: "Fix the flaky login test" }),
    );
    await until(() => o.get(job.id).status === "running");
    const ask = workers[0].call(
      "pelican_ask",
      { question: "Which build should I test?" },
      "ask-1",
    );
    await until(() => o.get(job.id).pending.length === 1);
    await lead.note("Watching the login fix.");
    const menu = start(t, gateway.as("menu", { cwd: dir })),
      name = job.agentName;
    await menu.shows(name + " asks lead");
    assert.equal(menu.output.modes.get("1000"), true);
    assert.match(menu.output.text(), /Codex agents for any orchestrator/);
    await menu.type(keys.enter, "a", "Release build", keys.enter);
    await menu.shows("Take this agent over?");
    await menu.type("y");
    await until(() => workers[0].answer(ask));
    assert.deepEqual(
      JSON.parse(workers[0].answer(ask).result.contentItems[0].text),
      { answer: "Release build", from: "menu" },
    );
    assert.equal(o.get(job.id).owner, "menu");
    await menu.shows("Answered");
    await menu.type(":", name, keys.enter);
    await menu.shows(/Chat\s+Brief\s+Result\s+Resources/);
    workers[0].emit("notification", {
      method: "item/started",
      params: {
        item: { id: "c1", type: "commandExecution", command: "npm test" },
      },
    });
    await menu.shows(/Running\s+npm test/);
    workers[0].emit("notification", {
      method: "item/completed",
      params: {
        item: {
          id: "c1",
          type: "commandExecution",
          command: "npm test",
          exitCode: 0,
          durationMs: 1500,
          aggregatedOutput: "ok 1 login\n",
        },
      },
    });
    await menu.shows(/Ran\s+npm test\s+✓ 1\.5s/);
    await menu.click("npm test");
    await menu.shows("ok 1 login");
    await menu.shows(/\$ npm test/);
    for (let n = 1; n <= 8; n++)
      workers[0].say("Checked run " + n + " of 8.", "commentary");
    await menu.shows("Checked run 8 of 8.");
    await menu.type(keys.enter, "i", keys.up);
    await menu.shows("Paused");
    workers[0].say("Both builds pass three times in a row.", "commentary");
    await menu.shows(/↓ \d+ new/);
    await menu.type(keys.end);
    await menu.shows("Both builds pass three times in a row.");
    await menu.type(keys.escape, keys.enter, "m", "Use port 4319", keys.enter);
    await until(() => workers[0].last("turn/steer"));
    assert.match(
      workers[0].last("turn/steer").params.input[0].text,
      /Use port 4319/,
    );
    await menu.type(keys.enter, "x");
    await menu.shows("Stop " + name + "?");
    await menu.type("y");
    await until(() => o.get(job.id).status === "interrupted");
    await menu.shows("stopped");
    menu.output.resize(80, 24);
    await menu.shows("Pelican needs 100 x 28");
    menu.output.resize(120, 30);
    await menu.shows(name);
    const own = (await gateway.as("menu").feed()).entries.map(
      (entry) => entry.title,
    );
    assert.ok(own.includes("menu took over " + name + " from lead"));
    assert.ok(own.includes("messaged " + name + " (steer, steered)"));
    assert.ok(own.includes("stopped " + name));
    await menu.type("q");
    assert.equal(await menu.done, 0);
    assert.equal(menu.output.modes.get("1049"), false);
    assert.equal(menu.output.modes.get("1000"), false);
    assert.equal(menu.output.modes.get("1006"), false);
    assert.ok(menu.output.chunks.join("").endsWith("\x1b[?7h"));
  },
);

test("terminal replies leave the splash waiting, and keyboard navigation needs no Enter-to-open", async (t) => {
  const { gateway, dir } = await harness(t),
    menu = start(t, gateway.as("menu", { cwd: dir }), { splash: true });
  await menu.shows("Press any key to start");
  const replies = [
    "\x1b[I",
    "\x1b[O",
    "\x1b[24;80R",
    "\x1b[?1;2c",
    "\x1b]11;rgb:0000/0000/0000\x1b\\",
    "\x1bP>|xterm(380)\x1b\\",
  ];
  for (const reply of replies) await menu.type(reply);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.match(menu.output.text(), /Press any key to start/);
  await menu.type(keys.enter);
  await menu.shows("Overview");
  await menu.type("j");
  assert.match(menu.output.text(), /Overview/);
  await menu.type(keys.down);
  await menu.shows(/load[\s\S]*0\/4/);
  await menu.type("q");
  assert.equal(await menu.done, 0);
});

test("mouse reporting can be disabled without affecting navigation", async (t) => {
  const { gateway, dir } = await harness(t),
    menu = start(t, gateway.as("menu", { cwd: dir }), { mouse: false });
  await menu.shows("Overview");
  assert.notEqual(menu.output.modes.get("1000"), true);
  await menu.type("\x1b[<0;8;14M", keys.down);
  await menu.shows(/load[\s\S]*0\/4/);
  await menu.type("q");
  assert.equal(await menu.done, 0);
});

const down = () =>
  Object.assign(
    new Error(
      "Pelican is not running (nothing answers at http://127.0.0.1:4319). Start it: pelican start",
    ),
    { code: "PELICAN_DOWN" },
  );

test("the menu starts the service itself when none answers", async (t) => {
  const { gateway, dir } = await harness(t),
    inner = gateway.as("menu", { cwd: dir });
  let started = 0;
  const client = {
    context: inner.context,
    call: (method, params) =>
      started ? inner.call(method, params) : Promise.reject(down()),
  };
  const menu = start(t, client, {
    startService: async () => {
      started++;
      return { started: true };
    },
  });
  await menu.shows("Overview");
  assert.equal(started, 1);
  await menu.type("q");
  assert.equal(await menu.done, 0);
});

test("a branded service notice appears when the service cannot start, and Enter tries again", async (t) => {
  const { gateway, dir } = await harness(t),
    inner = gateway.as("menu", { cwd: dir });
  let attempts = 0,
    works = false;
  const client = {
    context: inner.context,
    call: (method, params) =>
      works ? inner.call(method, params) : Promise.reject(down()),
  };
  const menu = start(t, client, {
    startService: async () => {
      attempts++;
      if (!works && attempts === 1) throw new Error("Pelican did not answer.");
      works = true;
      return { started: true };
    },
  });
  await menu.shows("Pelican is not running.");
  await menu.shows("Pelican did not answer.");
  // Only the first launch starts it by itself; a visible Enter tries again.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(attempts, 1);
  await menu.type("s");
  assert.equal(attempts, 1);
  await menu.click("Start service");
  await menu.shows("Pelican started.");
  await menu.shows("Overview");
  assert.equal(attempts, 2);
  await menu.type("q");
  assert.equal(await menu.done, 0);
});

test("pelican with no command prints pelican status when there is no terminal", async (t) => {
  if (process.stdin.isTTY && process.stdout.isTTY)
    return t.skip("this run has a terminal");
  const { gateway, dir } = await harness(t);
  for (const argv of [[], ["menu"], ["--as", "ntanis"]]) {
    const out = [];
    const code = await main(argv, {
      print: (text) => out.push(text),
      error: (text) => out.push(text),
      client: gateway.as("lead", { cwd: dir }),
    });
    assert.equal(code, 0, argv.join(" "));
    assert.match(out.join("\n"), /^Pelican is running: process \d+/);
    assert.match(out.join("\n"), /test-ws {2}/);
  }
  const json = [];
  await main(["menu", "--json"], {
    print: (text) => json.push(text),
    client: gateway.as("lead", { cwd: dir }),
  });
  assert.equal(JSON.parse(json.join("")).workspaces[0].id, "test-ws");
});
