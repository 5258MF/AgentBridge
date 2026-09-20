import test from "node:test";
import assert from "node:assert/strict";
import { encodingPreludeInsertIndex } from "../src/extension/src/ide-tool-broker.js";

const BT = "\x60";

test("the prelude goes after a simple param block", () => {
  const command = "param($a)";
  assert.equal(encodingPreludeInsertIndex(command), command.length);
});

test("an escaped quote inside the block does not close it", () => {
  // PowerShell escapes with a backtick, so the "` pair below is a literal quote. Treating it
  // as the end of the string would make the following paren end the block early, and the
  // encoding prelude would then be injected into the middle of an expression.
  const command = `param([string]$x = "say ${BT}"hi${BT}"")`;
  assert.equal(encodingPreludeInsertIndex(command), command.length);
});

test("a comment inside the block cannot close it", () => {
  const command = "param(\n  $x = 1 # ) not a close\n)";
  assert.equal(encodingPreludeInsertIndex(command), command.length);
});

test("a command with no param block has no insertion point", () => {
  assert.equal(encodingPreludeInsertIndex("Write-Output hi"), -1);
});

test("a comment before param does not hide the block", () => {
  // param() still has to be the first *statement*, so a script that starts with comments is
  // legal. Inserting the prelude before the comments would put a statement ahead of param
  // and PowerShell would refuse to parse the script at all.
  const command = "# build the report\nparam($a)\nWrite-Output $a";
  assert.equal(encodingPreludeInsertIndex(command), command.indexOf("\nWrite-Output"));
});

test("a #requires line before param does not hide the block", () => {
  const command = "#requires -Version 5.1\n#requires -Modules @{ModuleName='x'}\nparam(\n  $a = 1\n)\nWrite-Output $a";
  assert.equal(encodingPreludeInsertIndex(command), command.indexOf("\nWrite-Output"));
});

test("param is matched case-insensitively like the rest of PowerShell", () => {
  const command = "PARAM($a)";
  assert.equal(encodingPreludeInsertIndex(command), command.length);
});

test("a single-quoted here-string inside the block cannot close it early", () => {
  // Read as an ordinary string, the apostrophe in "it's" would end it and the ")" on the
  // next line would then look like the end of the param block, splicing the prelude into
  // the middle of $x's default value.
  const command = "param(\n  $x = @'\nit's got a ) paren\n'@\n)\nWrite-Output $x";
  assert.equal(encodingPreludeInsertIndex(command), command.indexOf("\nWrite-Output"));
});

test("an unpaired block falls back to a lone closing paren on its own line", () => {
  // The double quote is never closed, so the depth scan cannot pair the block at all. The
  // conventional ")" in the first column is still a safe insertion point, and without the
  // fallback the prelude would be dropped entirely.
  const command = "param(\n  $a = \"unclosed\n)\nWrite-Output $a";
  const insertAt = encodingPreludeInsertIndex(command);
  assert.ok(insertAt > command.indexOf(")"), "the prelude must land after the closing paren");
  assert.ok(command.slice(insertAt).startsWith("Write-Output"), "and before the first statement");
});

test("a block comment before param does not hide the block", () => {
  // <# ... #> is a comment to PowerShell exactly as # is, so param is still the first
  // statement and the prelude still belongs after it. Only the line-comment form was skipped:
  // a script opening with a block comment had no recognised param block at all, so the
  // prelude was written at the very top - in front of param - and the script would not parse.
  const command = "<# setup #>\nparam($a)";
  assert.equal(encodingPreludeInsertIndex(command), command.length);
});

test("a block comment spanning lines is skipped whole", () => {
  // Skipping is what keeps a stray ")" inside the comment from ending the depth scan early:
  // without it the prelude lands in the middle of the comment rather than after param.
  const command = "<#\n  line one\n  ) not a close\n#>\nparam($a)";
  assert.equal(encodingPreludeInsertIndex(command), command.length);
});
