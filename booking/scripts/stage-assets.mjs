#!/usr/bin/env node
// Stage the public marketing site into booking/public/ from an explicit
// allow-list. `npm run dev` and `npm run deploy` run this first.
//
// Security (site-publishing spec, design D11): the Worker serves static assets
// ONLY from booking/public, and this script is the only thing that fills it.
// Nothing outside the allow-list (booking source, specs, business notes,
// .dev.vars, CLAUDE.md, editor junk) can ever be served, because it is never
// copied. The folder is wiped first, so a file removed from the site (or from
// the allow-list) also disappears from the next deploy. Dotfiles and symlinks
// inside allow-listed folders are skipped too (.DS_Store, a stray .env).
//
// Zero dependencies: Node's fs only. Usage: node scripts/stage-assets.mjs

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOKING_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(BOOKING_DIR, '..');
const PUBLIC_DIR = join(BOOKING_DIR, 'public');

// Everything the public site needs, relative to the repo root. A trailing
// slash marks a folder (copied recursively, minus dotfiles and symlinks).
export const ALLOW_LIST = [
  'index.html', 'classes.html', 'about.html', 'contact.html',
  'css/', 'js/', 'assets/',
  'robots.txt', 'sitemap.xml',
];

// Workers Assets rejects any single file over 25 MiB, which would fail the
// whole deploy. Such files (print-resolution artwork) are not linked from the
// site, so they are skipped with a warning instead.
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const JUNK_NAMES = new Set(['Thumbs.db', 'desktop.ini']);

export function stageAssets({ root = REPO_ROOT, out = PUBLIC_DIR, log = console.log } = {}) {
  // Guard the rm -rf below: only ever wipe a folder called "public".
  if (basename(out) !== 'public') throw new Error(`stage-assets: refusing to clear ${out}`);

  const skipped = [];
  const publishable = (path) => {
    const name = basename(path);
    if (name.startsWith('.') || JUNK_NAMES.has(name)) return false;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return false;
    if (stat.isFile() && stat.size > MAX_ASSET_BYTES) {
      skipped.push(relative(root, path));
      return false;
    }
    return stat.isFile() || stat.isDirectory();
  };

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  for (const entry of ALLOW_LIST) {
    const isDir = entry.endsWith('/');
    const name = isDir ? entry.slice(0, -1) : entry;
    const src = join(root, name);
    if (!existsSync(src)) throw new Error(`stage-assets: allow-listed path is missing: ${entry}`);
    const stat = lstatSync(src);
    if (stat.isSymbolicLink() || stat.isDirectory() !== isDir) {
      throw new Error(`stage-assets: ${entry} is not a plain ${isDir ? 'folder' : 'file'}`);
    }
    cpSync(src, join(out, name), { recursive: true, filter: publishable });
  }

  let files = 0;
  const walk = (dir) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (item.isDirectory()) walk(join(dir, item.name));
      else files += 1;
    }
  };
  walk(out);

  for (const path of skipped) {
    log(`stage-assets: WARNING skipped ${path} (over the 25 MiB Workers Assets limit)`);
  }
  log(`stage-assets: staged ${files} files into ${relative(REPO_ROOT, out).split(sep).join('/')}/`);
  return { files, skipped };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stageAssets();
}
