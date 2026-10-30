import test from "node:test";
import assert from "node:assert/strict";
import { renderToString } from "ink";
import { createLoginOutput, signIn } from "../src/menu/login.js";
import { fileURLToPath } from "node:url";
import { VirtualTerminal } from "./virtual-terminal.js";
import { until } from "./helpers.js";
import { LoginScreen } from "../src/menu/ui/login.js";
import { h } from "../src/menu/ui/kit.js";
import { clean, width } from "../src/menu/text.js";
import { logo } from "../src/menu/art.js";

const url =
  "https://auth.openai.com/oauth/authorize?client_id=fixture&state=public&code=true";

test("the fake login child gets login arguments and a branded frame that resizes and restores", async () => {
  const output = new VirtualTerminal(120, 30);
  const done = signIn({
    launcher: {
      command: process.execPath,
      prefix: [
        fileURLToPath(
          new URL("./fixtures/fake-menu-login.js", import.meta.url),
        ),
      ],
    },
    env: process.env,
    name: "Your ChatGPT account",
    output,
    stdio: "ignore",
    color: false,
    glyphs: "rich",
  });
  await until(() => output.text().includes("Open ChatGPT sign-in"));
  assert.doesNotMatch(output.text(), /Private diagnostic|client_id/);
  output.resize(80, 24);
  assert.match(output.text(), /Pelican needs 100 x 28/);
  output.resize(120, 30);
  assert.match(output.text(), /Open ChatGPT sign-in/);
  assert.equal(await done, 0);
  assert.equal(output.modes.get("1049"), false);
  assert.ok(output.chunks.join("").endsWith("\x1b[?7h"));
});

test("sign-in extracts a public link across chunks and a prompt without exposing raw output", () => {
  const updates = [],
    parser = createLoginOutput((update) => updates.push(update));
  parser.push(
    Buffer.from("unrelated output\nhttps://auth.openai.com/oauth/auth"),
  );
  assert.equal(updates.length, 0);
  parser.push(Buffer.from("orize?client_id=fixture&state=public&code=true\n"));
  assert.deepEqual(updates.at(-1), { url, codePrompt: false });
  parser.push(Buffer.from("Paste the verification code here: "));
  assert.deepEqual(updates.at(-1), { url, codePrompt: true });
  parser.end();
  assert.equal(updates.length, 2);
});

test("sign-in ignores tokens, callbacks, untrusted domains and terminal escapes", () => {
  const updates = [],
    parser = createLoginOutput((update) => updates.push(update));
  for (const invalid of [
    "https://auth.openai.com/oauth/authorize?access_token=private",
    "https://auth.openai.com/oauth/authorize?code=private",
    "https://auth.openai.com/oauth/callback?code=private",
    "https://auth.openai.com.example.com/oauth/authorize?client_id=fixture",
    "https://example.com/oauth/authorize?client_id=fixture",
    "https://someone:private@auth.openai.com/oauth/authorize",
    "https://auth.openai.com/oauth/authorize#private",
  ])
    parser.push(Buffer.from(invalid + "\n"));
  parser.push(Buffer.from("\x1b[2Jthis output must not be displayed\n"));
  parser.end();
  assert.deepEqual(updates, []);
});

test("the sign-in layout carries the ASCII identity and fits the supported terminal sizes", () => {
  for (const size of [
    { cols: 100, rows: 28 },
    { cols: 120, rows: 30 },
    { cols: 160, rows: 45 },
  ]) {
    const ansi = renderToString(
      h(LoginScreen, {
        state: { size, color: false, glyphs: "rich" },
        name: "work@example.com",
        url,
        codePrompt: true,
      }),
      { columns: size.cols },
    );
    const text = clean(ansi),
      lines = text.split("\n");
    assert.equal(lines.length, size.rows - 1);
    assert.ok(lines.every((line) => width(line) <= size.cols));
    for (const line of logo) assert.ok(text.includes(line.trim()));
    assert.match(text, /Connect ChatGPT/);
    assert.match(text, /Open ChatGPT sign-in/);
    assert.match(text, /VERIFICATION CODE/);
    assert.doesNotMatch(text, /client_id|state=public/);
  }
});
