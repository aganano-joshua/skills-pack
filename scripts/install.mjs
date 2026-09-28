import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileAsync, treeHash, validateManifestShape, validateSkillDirectory } from "./lib.mjs";
import { validateRepository } from "./validate.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function parseArguments(argv) {
  const options = { target: process.cwd(), agent: "*", force: false, context: false, forceContext: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") options.target = argv[++index];
    else if (argument === "--agent") options.agent = argv[++index];
    else if (argument === "--force") options.force = true;
    else if (argument === "--context") options.context = true;
    else if (argument === "--force-context") {
      options.context = true;
      options.forceContext = true;
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.target || !options.agent) throw new Error("--target and --agent require values");
  options.target = resolve(options.target);
  return options;
}

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function checkoutPinnedSkill(skill, checkoutRoot) {
  const repository = join(checkoutRoot, skill.name);
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", "--quiet", repository]);
  await execFileAsync("git", ["-C", repository, "remote", "add", "origin", skill.repository]);
  await execFileAsync("git", ["-C", repository, "fetch", "--quiet", "--depth", "1", "origin", skill.revision]);
  await execFileAsync("git", ["-C", repository, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  const source = join(repository, skill.path);
  await validateSkillDirectory(source, skill.name);
  const hash = await treeHash(source);
  if (hash !== skill.contentHash) throw new Error(`${skill.name} upstream content does not match its pinned hash`);
  return source;
}

async function runSkillsCli(source, stage, agent, skillName = "*") {
  const binary = join(repositoryRoot, "node_modules", ".bin", process.platform === "win32" ? "skills.cmd" : "skills");
  await execFileAsync(binary, ["add", source, "--skill", skillName, "--agent", agent, "--yes", "--copy", "--json"], {
    cwd: stage,
    maxBuffer: 20 * 1024 * 1024,
  });
}

async function findInstalledSkillDirectories(root, names, current = "") {
  const directory = join(root, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const next = current ? join(current, entry.name) : entry.name;
    if (!entry.isDirectory()) continue;
    if (names.has(entry.name) && (await exists(join(root, next, "SKILL.md")))) found.push(next);
    else found.push(...(await findInstalledSkillDirectories(root, names, next)));
  }
  return found;
}

async function directoryBytes(root) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else if (entry.isFile()) bytes += (await lstat(path)).size;
  }
  return bytes;
}

async function mergeLock(stage, target, manifest) {
  const stageLock = JSON.parse(await readFile(join(stage, "skills-lock.json"), "utf8"));
  const targetPath = join(target, "skills-lock.json");
  const targetLock = (await exists(targetPath))
    ? JSON.parse(await readFile(targetPath, "utf8"))
    : { version: 1, skills: {} };
  targetLock.version = 1;
  targetLock.skills ??= {};
  for (const skill of manifest.skills) {
    const staged = stageLock.skills?.[skill.name];
    if (!staged) throw new Error(`The skills CLI did not write a lock entry for ${skill.name}`);
    const source = new URL(skill.repository).pathname.replace(/^\//, "").replace(/\.git$/, "");
    targetLock.skills[skill.name] = {
      source,
      sourceType: "github",
      skillPath: `${skill.path}/SKILL.md`,
      computedHash: staged.computedHash,
    };
  }
  const body = `${JSON.stringify(targetLock, null, 2)}\n`;
  const current = (await exists(targetPath)) ? await readFile(targetPath, "utf8") : null;
  return { path: targetPath, body, changed: current !== body };
}

async function replaceDirectory(source, destination, target, backupRoot, created, replaced) {
  await mkdir(dirname(destination), { recursive: true });
  if (await exists(destination)) {
    const backup = join(backupRoot, relative(target, destination));
    await mkdir(dirname(backup), { recursive: true });
    await rename(destination, backup);
    replaced.push({ destination, backup });
  } else created.push(destination);
  await cp(source, destination, { recursive: true, errorOnExist: true });
}

export function assertConflictPolicy(skillConflicts, contextConflicts, options) {
  if (skillConflicts.length && !options.force) {
    throw new Error(`Different skills already exist: ${skillConflicts.join(", ")}. Use --force to replace them.`);
  }
  if (contextConflicts.length && !options.forceContext) {
    throw new Error(`Different context files already exist: ${contextConflicts.join(", ")}. Use --force-context to replace them.`);
  }
}

async function removeEmptyParents(path, target) {
  let current = dirname(path);
  while (current !== target && current.startsWith(`${target}/`)) {
    try {
      await rmdir(current);
    } catch {
      break;
    }
    current = dirname(current);
  }
}

export async function applyTransaction({ changes, lock, target, failAfter = Number.POSITIVE_INFINITY }) {
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const backupRoot = join(target, ".skills-pack-backups", timestamp);
  const created = [];
  const replaced = [];
  let mutations = 0;

  try {
    for (const change of changes) {
      if (change.file) {
        await mkdir(dirname(change.destination), { recursive: true });
        if (await exists(change.destination)) {
          const backup = join(backupRoot, relative(target, change.destination));
          await mkdir(dirname(backup), { recursive: true });
          await cp(change.destination, backup);
          replaced.push({ destination: change.destination, backup, file: true });
        } else created.push(change.destination);
        await cp(change.source, change.destination, { force: true });
      } else await replaceDirectory(change.source, change.destination, target, backupRoot, created, replaced);
      mutations += 1;
      if (mutations === failAfter) throw new Error("Injected installation failure");
    }

    if (lock.changed) {
      if (await exists(lock.path)) {
        const backup = join(backupRoot, "skills-lock.json");
        await mkdir(dirname(backup), { recursive: true });
        await cp(lock.path, backup);
        replaced.push({ destination: lock.path, backup, file: true });
      } else created.push(lock.path);
      await writeFile(lock.path, lock.body);
    }
  } catch (error) {
    for (const path of created.reverse()) {
      await rm(path, { recursive: true, force: true });
      await removeEmptyParents(path, target);
    }
    for (const item of replaced.reverse()) {
      await rm(item.destination, { recursive: true, force: true });
      await mkdir(dirname(item.destination), { recursive: true });
      await rename(item.backup, item.destination);
    }
    await rm(backupRoot, { recursive: true, force: true });
    await removeEmptyParents(backupRoot, target);
    throw error;
  }

  return { backupRoot: replaced.length ? backupRoot : null };
}

export async function install(options) {
  await access(options.target, constants.W_OK);
  await validateRepository(repositoryRoot);
  const manifest = JSON.parse(await readFile(join(repositoryRoot, "sources.json"), "utf8"));
  validateManifestShape(manifest);

  const work = await mkdtemp(join(tmpdir(), "skills-pack-install-"));
  const checkouts = join(work, "checkouts");
  const stage = join(work, "stage");
  await mkdir(checkouts);
  await mkdir(stage);
  await writeFile(join(stage, "package.json"), '{"private":true}\n');

  try {
    await runSkillsCli(repositoryRoot, stage, options.agent);
    for (const skill of manifest.skills.filter((entry) => entry.distribution === "direct")) {
      const source = await checkoutPinnedSkill(skill, checkouts);
      await runSkillsCli(source, stage, options.agent, skill.name);
    }

    const names = new Set(manifest.skills.map((skill) => skill.name));
    const stagedDirectories = await findInstalledSkillDirectories(stage, names);
    const seen = new Set(stagedDirectories.map((path) => basename(path)));
    for (const name of names) if (!seen.has(name)) throw new Error(`No staged installation found for ${name}`);

    const skillConflicts = [];
    const contextConflicts = [];
    const changes = [];
    for (const relativePath of stagedDirectories) {
      const source = join(stage, relativePath);
      const destination = join(options.target, relativePath);
      if (!(await exists(destination))) changes.push({ source, destination });
      else if ((await treeHash(source)) !== (await treeHash(destination))) {
        skillConflicts.push(relativePath);
        changes.push({ source, destination });
      }
    }

    const contextFiles = options.context ? ["AGENTS.md", "CLAUDE.md"] : [];
    for (const name of contextFiles) {
      const source = join(repositoryRoot, name);
      const destination = join(options.target, name);
      if (!(await exists(destination))) changes.push({ source, destination, file: true });
      else if ((await readFile(source)).compare(await readFile(destination)) !== 0) {
        contextConflicts.push(name);
        changes.push({ source, destination, file: true });
      }
    }

    assertConflictPolicy(skillConflicts, contextConflicts, options);

    const required = await directoryBytes(stage);
    const filesystem = await statfs(options.target);
    if (Number(filesystem.bavail) * Number(filesystem.bsize) < required * 2) {
      throw new Error("The target does not have enough free space for installation and rollback data");
    }

    const lock = await mergeLock(stage, options.target, manifest);
    const transaction = await applyTransaction({ changes, lock, target: options.target });

    return { installed: changes.length, skipped: stagedDirectories.length - changes.filter((item) => !item.file).length, backupRoot: transaction.backupRoot };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  install(options)
    .then((result) => {
      console.log(`Installed or updated ${result.installed} targets. Skipped ${result.skipped} matching targets.`);
      if (result.backupRoot) console.log(`Backups: ${result.backupRoot}`);
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
