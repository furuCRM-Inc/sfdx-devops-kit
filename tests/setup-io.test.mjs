/**
 * The setup wizard's terminal prompts.
 *
 * The one that matters is askSecret: a Backlog API key is normally *pasted*,
 * so it arrives as a single chunk, and it must never reach the screen — the
 * terminal's scrollback outlives the wizard.
 */

import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";

import { createIO } from "../src/setup-io.mjs";

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

/** A terminal-like pair: readline echoes, and we can read everything printed. */
function fakeTerminal() {
  const input = new PassThrough();
  const printed = [];
  const output = new Writable({
    write(chunk, encoding, callback) {
      printed.push(String(chunk));
      callback();
    },
  });
  // `terminal: true` is what a real tty gives us, and what makes readline —
  // rather than the tty driver — responsible for echoing.
  const io = createIO({ input, output, terminal: true });
  return { io, input, text: () => printed.join("") };
}

test("a pasted secret is accepted whole and never echoed", async () => {
  const { io, input, text } = fakeTerminal();
  const answer = io.askSecret("API キー");

  await tick();
  // A paste arrives as one chunk, not keystroke by keystroke.
  input.write("aBcD1234aBcD1234aBcD1234\n");

  assert.equal(await answer, "aBcD1234aBcD1234aBcD1234");
  assert.ok(text().includes("API キー"), "the prompt is shown");
  assert.ok(!text().includes("aBcD1234"), "the key must not appear on screen");
  io.close();
});

test("an ordinary prompt still echoes and trims", async () => {
  const { io, input, text } = fakeTerminal();
  const answer = io.ask("プロジェクト名", "fallback");

  await tick();
  input.write("  demo-crm  \n");

  assert.equal(await answer, "demo-crm");
  assert.ok(text().includes("[fallback]"), "the default is shown");
  assert.ok(text().includes("demo-crm"), "a non-secret answer is visible");
  io.close();
});

test("an empty answer takes the default", async () => {
  const { io, input } = fakeTerminal();
  const answer = io.ask("プロジェクト名", "wiz2");
  await tick();
  input.write("\n");
  assert.equal(await answer, "wiz2");
  io.close();
});

test("yes/no re-asks until the answer is one or the other", async () => {
  const { io, input, text } = fakeTerminal();
  const answer = io.confirm("続けますか", false);

  await tick();
  input.write("maybe\n");
  await tick();
  input.write("y\n");

  assert.equal(await answer, true);
  assert.ok(
    text().includes("y か n で答えてください"),
    "the operator is told why",
  );
  io.close();
});

test("yes/no accepts Japanese and empty answers", async () => {
  const { io, input } = fakeTerminal();
  const yes = io.confirm("続けますか", false);
  await tick();
  input.write("はい\n");
  assert.equal(await yes, true);

  const fallback = io.confirm("続けますか", false);
  await tick();
  input.write("\n");
  assert.equal(
    await fallback,
    false,
    "an empty answer takes the stated default",
  );
  io.close();
});
