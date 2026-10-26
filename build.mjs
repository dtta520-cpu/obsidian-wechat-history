import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
const out = 'dist/wechat-history-archive';
await fs.mkdir(out, { recursive: true });
const built = await build({ entryPoints: ['plugin/main.mjs'], bundle: true, platform: 'node', target: 'es2022', format: 'cjs', metafile: true,
  external: ['obsidian', 'electron'], outfile: `${out}/main.js`, sourcemap: false, minify: false,
  footer: { js: '\nmodule.exports = module.exports.default;' },
});
for (const file of ['manifest.json', 'styles.css']) await fs.copyFile(file, `${out}/${file}`);
const packages = new Set();
for (const input of Object.keys(built.metafile.inputs).filter(name => name.includes('node_modules/'))) {
  let current = path.dirname(path.resolve(input));
  while (current.includes('node_modules')) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(current, 'package.json'), 'utf8'));
      if (pkg.name && pkg.version) { packages.add(current); break; }
    } catch {}
    current = path.dirname(current);
  }
}
const notices = ['Third-party software included in this bundle.\n'];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const files = (await fs.readdir(directory)).filter(name => /^licen[cs]e(?:\.|$)/i.test(name));
  if (!files.length) throw new Error(`License file missing for ${pkg.name}`);
  notices.push(`\n=== ${pkg.name} ${pkg.version} (${pkg.license}) ===\n`);
  for (const file of files) notices.push(await fs.readFile(path.join(directory, file), 'utf8'));
}
await fs.writeFile(`${out}/THIRD-PARTY-NOTICES.txt`, notices.join('\n'));
await fs.copyFile('README.md', `${out}/README.md`);
console.log(`Built ${out}`);
