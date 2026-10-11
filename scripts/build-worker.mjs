import {copyFile, mkdir, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {dirname, join, relative} from "node:path";

const projectRoot = process.cwd();
const templatePath = join(projectRoot, "server", "index.template.js");
const outputPath = join(projectRoot, "dist", "server", "index.js");
const staticDirectory = join(projectRoot, "dist", "public");
const publicExtensions = new Set([
  ".html", ".css", ".js", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".ico", ".svg", ".woff2", ".txt", ".xml", ".ogg"
]);
const excludedDirectories = new Set([
  ".git", ".openai", "dist", "db", "drizzle", "server",
  "node_modules", "data", "uploads", "audits", "tmp", "output", "font-lab",
  ".perf-originals", "screenshots", "screenshot", "test", "tests", "__tests__", "fixtures"
]);
const excludedFiles = new Set([
  // Local-only demo/test seeders must never become public Worker assets.
  "scripts/demo-blog-seed.js",
  "scripts/demo-community-seed.js",
  "scripts/demo-submission-seed.js"
]);

async function collectFiles(directory, prefix = "") {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || (entry.isDirectory() && excludedDirectories.has(entry.name))) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath, relativePath));
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase();
    if ((entry.name === "_headers" || publicExtensions.has(extension)) && !excludedFiles.has(relativePath)) files.push(relativePath);
  }
  return files;
}

const creditImplementation = (await readFile(join(projectRoot, "server", "monthly-credits.inc.js"), "utf8"))
  .replace("/* MONTHLY_CREDIT_SCHEMA */", JSON.stringify(await readFile(join(projectRoot, "drizzle", "0015_monthly_credits.sql"), "utf8")));
const template = (await readFile(templatePath, "utf8"))
  .replace("/* MONTHLY_CREDIT_IMPLEMENTATION */", creditImplementation)
  .replace("/* PASSWORD_RECOVERY_IMPLEMENTATION */", await readFile(join(projectRoot, "server", "password-recovery.inc.js"), "utf8"));
const publicFiles = (await collectFiles(projectRoot)).sort();

// Keep the Worker code small. Cloudflare's native static-asset pipeline handles
// the public files separately, including edge caching and content compression.
await rm(staticDirectory, {recursive: true, force: true});
await mkdir(staticDirectory, {recursive: true});
for (const assetPath of publicFiles) {
  const sourcePath = join(projectRoot, ...assetPath.split("/"));
  const destinationPath = join(staticDirectory, ...assetPath.split("/"));
  await mkdir(dirname(destinationPath), {recursive: true});
  await copyFile(sourcePath, destinationPath);
}

await mkdir(join(projectRoot, "dist", "server"), {recursive: true});
await writeFile(outputPath, template);
console.log(`Built ${relative(projectRoot, outputPath)} and staged ${publicFiles.length} static assets in ${relative(projectRoot, staticDirectory)}.`);
