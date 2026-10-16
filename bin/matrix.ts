#!/usr/bin/env bun
// Матрица версий omp: прогоняет ./test против указанных версий
// @oh-my-pi/pi-coding-agent, установленных во временный prefix.
// Глобальная установка не затрагивается: тесты резолвят omp по PATH.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
let versions = args;
if (!versions.length) {
  const source = readFileSync(join(import.meta.dir, "..", "src", "runtime.ts"), "utf8");
  const match = source.match(/SUPPORTED_OMP_VERSIONS[^=]*=\s*\[([^\]]*)\]/);
  if (!match) throw new Error("Cannot parse SUPPORTED_OMP_VERSIONS from src/runtime.ts");
  versions = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}
const failures: string[] = [];
for (const version of versions) {
  const prefix = join("/tmp/omp-matrix", version);
  console.log(`\n=== omp ${version}: install into ${prefix} ===`);
  await Bun.$`rm -rf ${prefix}`.quiet();
  const install =
    await Bun.$`npm --prefix ${prefix} install --no-audit --no-fund @oh-my-pi/pi-coding-agent@${version}`
      .quiet()
      .nothrow();
  if (install.exitCode)
    throw new Error(`npm install failed for ${version}:\n${install.stderr.toString()}`);
  const ompBin = join(prefix, "node_modules", ".bin", "omp");
  const versionCheck = await Bun.$`${ompBin} --version`.quiet().nothrow();
  if (versionCheck.exitCode || !versionCheck.stdout.toString().trim().endsWith(version))
    throw new Error(`omp ${version} binary check failed: ${versionCheck.stdout.toString().trim()}`);
  console.log(`=== omp ${version}: bun test ./test ===`);
  const started = Date.now();
  const proc = Bun.spawn(["bun", "test", "./test"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, PATH: `${join(prefix, "node_modules", ".bin")}:${process.env.PATH}` },
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  const ok = code === 0;
  console.log(
    `=== omp ${version}: ${ok ? "PASS" : "FAIL"} in ${Math.round((Date.now() - started) / 1000)}s ===`,
  );
  if (!ok) failures.push(version);
}
if (failures.length) {
  console.error(`Matrix failures: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`Matrix OK: ${versions.join(", ")}`);
