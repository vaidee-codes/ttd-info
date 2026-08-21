import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pages = [
  ['index.html', '/'],
  ['pass/index.html', '/pass'],
  ['pass/status.html', '/pass'],
  ['pass/success.html', '/pass'],
  ['demos.html', '/demos'],
  ['guides.html', '/guides'],
  ['support.html', '/support'],
  ['PRIVACY_POLICY.html', null],
  ['terms.html', null],
  ['refund-policy.html', null]
];

const expectedNavigation = [
  ['/', 'Home'],
  ['/pass', 'Pass'],
  ['/demos', 'Demos'],
  ['/guides', 'Guides'],
  ['/support', 'Support']
];

const expectedFooterLinks = [
  '/pass',
  '/demos',
  '/guides',
  '/support',
  '/PRIVACY_POLICY',
  '/terms',
  '/refund-policy',
  'mailto:ttdautofill@gmail.com'
];

function block(html, className, tag) {
  const match = html.match(new RegExp(`<${tag} class="${className}"[\\s\\S]*?<\\/${tag}>`));
  assert.ok(match, `missing .${className}`);
  return match[0];
}

function links(html) {
  return [...html.matchAll(/<a\b([^>]*)>([^<]+)<\/a>/g)].map((match) => {
    const href = match[1].match(/href="([^"]+)"/)?.[1];
    return { href, label: match[2].trim(), current: /aria-current="page"/.test(match[1]) };
  });
}

test('every public page uses the same route-only global navigation', () => {
  for (const [file, currentRoute] of pages) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const nav = block(html, 'site-nav', 'nav');
    assert.match(nav, /<a class="brand" href="\/">/, `${file}: brand must link home`);

    const navLinks = links(block(nav, 'nav-links', 'div'));
    assert.deepEqual(
      navLinks.map(({ href, label }) => [href, label]),
      expectedNavigation,
      `${file}: navigation differs from the site contract`
    );
    assert.ok(navLinks.every(({ href }) => !href.includes('#') && !href.endsWith('.html')), `${file}: global navigation must not mix page scrolling or filename URLs`);

    const current = navLinks.filter(({ current }) => current).map(({ href }) => href);
    assert.deepEqual(current, currentRoute ? [currentRoute] : [], `${file}: incorrect active navigation item`);
  }
});

test('every public page exposes the same support and legal footer routes', () => {
  for (const [file] of pages) {
    const html = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const footer = block(html, 'site-footer', 'footer');
    const hrefs = links(footer).map(({ href }) => href);
    for (const expected of expectedFooterLinks) {
      assert.ok(hrefs.includes(expected), `${file}: footer is missing ${expected}`);
    }
  }
});

test('the demos page exposes three distinct video guides', () => {
  const html = readFileSync(new URL('../demos.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/player\.vimeo\.com\/video\/(\d+)/g)].map((match) => match[1]);
  assert.deepEqual(ids, ['1218623375', '1218622206', '1218622188']);
  assert.equal(new Set(ids).size, 3);
  assert.match(html, /SED booking — layover icon/);
  assert.match(html, /SED ticket booking demo/);
  assert.match(html, /Buy and activate a pass/);
});
