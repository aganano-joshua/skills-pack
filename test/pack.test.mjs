import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyTransaction, assertConflictPolicy, parseArguments } from "../scripts/install.mjs";
import { treeHash } from "../scripts/lib.mjs";
import { validateRepository } from "../scripts/validate.mjs";

test("the repository contains the approved 23 skill inventory", async () => {
  assert.deepEqual(await validateRepository(), { total: 23, snapshots: 20, direct: 3 });
});

test("tree hashes normalize line endings", async () => {
  const first = await mkdtemp(join(tmpdir(), "skills-hash-first-"));
  const second = await mkdtemp(join(tmpdir(), "skills-hash-second-"));
  try {
    await writeFile(join(first, "SKILL.md"), "---\nname: example\ndescription: example\n---\n");
    await writeFile(join(second, "SKILL.md"), "---\r\nname: example\r\ndescription: example\r\n---\r\n");
    assert.equal(await treeHash(first), await treeHash(second));
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test("installer arguments are explicit and safe by default", () => {
  const options = parseArguments(["--target", ".", "--agent", "claude-code", "--context"]);
  assert.equal(options.agent, "claude-code");
  assert.equal(options.force, false);
  assert.equal(options.context, true);
  assert.equal(options.forceContext, false);
});

test("unknown installer arguments fail", () => {
  assert.throws(() => parseArguments(["--surprise"]), /Unknown argument/);
});

test("different target content requires an explicit replacement option", () => {
  assert.throws(
    () => assertConflictPolicy([".claude/skills/example"], [], { force: false, forceContext: false }),
    /Use --force/,
  );
  assert.throws(
    () => assertConflictPolicy([], ["AGENTS.md"], { force: false, forceContext: false }),
    /Use --force-context/,
  );
  assert.doesNotThrow(() => assertConflictPolicy(["skill"], ["AGENTS.md"], { force: true, forceContext: true }));
});

test("an injected installation failure restores replaced content and removes new content", async () => {
  const target = await mkdtemp(join(tmpdir(), "skills-rollback-target-"));
  const incoming = await mkdtemp(join(tmpdir(), "skills-rollback-source-"));
  const existingDestination = join(target, ".claude", "skills", "existing");
  const newDestination = join(target, ".claude", "skills", "new-skill");
  const incomingExisting = join(incoming, "existing");
  const incomingNew = join(incoming, "new-skill");
  try {
    await mkdir(existingDestination, { recursive: true });
    await mkdir(incomingExisting, { recursive: true });
    await mkdir(incomingNew, { recursive: true });
    await writeFile(join(existingDestination, "SKILL.md"), "old\n");
    await writeFile(join(incomingExisting, "SKILL.md"), "replacement\n");
    await writeFile(join(incomingNew, "SKILL.md"), "new\n");
    await assert.rejects(
      applyTransaction({
        target,
        changes: [
          { source: incomingExisting, destination: existingDestination },
          { source: incomingNew, destination: newDestination },
        ],
        lock: { changed: false },
        failAfter: 2,
      }),
      /Injected installation failure/,
    );
    assert.equal(await readFile(join(existingDestination, "SKILL.md"), "utf8"), "old\n");
    await assert.rejects(readFile(join(newDestination, "SKILL.md")), /ENOENT/);
  } finally {
    await rm(target, { recursive: true, force: true });
    await rm(incoming, { recursive: true, force: true });
  }
});
