const assert = require('node:assert/strict');
const { test } = require('node:test');

const { injectSeoMeta } = require('../dist/utils/renderer');

const WRAPPER = '<html><head><title>Practice</title></head><body><main>Body</main></body></html>';
const SERVING = { host: 'practice.test', path: '/' };
// Built from char codes so no literal line/paragraph separator sits in this file.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const LD_JSON_BLOCK = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;

function hostileSchema() {
  return {
    '@context': 'https://schema.org',
    '@type': 'Dentist',
    name: 'Smith & Jones <Family> Dental',
    // A stored value that tries to end the script element and open new markup,
    // plus every special replacement-string sequence String.prototype.replace knows.
    description: `Gentle care</script><p data-escaped-marker>after</p> costs $& $' $\` $$ $1${LINE_SEPARATOR}next${PARAGRAPH_SEPARATOR}end`,
    url: 'https://practice.test/?a=1&b=2',
  };
}

function ldJsonBlocks(html) {
  return [...html.matchAll(LD_JSON_BLOCK)].map((match) => match[1]);
}

function count(html, pattern) {
  return (html.match(pattern) || []).length;
}

test('a schema value cannot close the JSON-LD script element', () => {
  const schema = hostileSchema();
  const html = injectSeoMeta(WRAPPER, { schema_json: [schema] }, SERVING);

  // Exactly one script element opens and closes: the value stayed inside it.
  assert.equal(count(html, /<script/gi), 1);
  assert.equal(count(html, /<\/script/gi), 1);
  assert.doesNotMatch(html, /<p data-escaped-marker>/);

  const [block] = ldJsonBlocks(html);
  for (const raw of ['<', '>', '&', LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
    assert.ok(!block.includes(raw), `JSON-LD text must not carry a raw ${JSON.stringify(raw)}`);
  }
  assert.match(block, /\\u003c\/script\\u003e/);
});

test('escaped JSON-LD still parses to the identical schema, `$` sequences included', () => {
  const schema = hostileSchema();
  const html = injectSeoMeta(WRAPPER, { schema_json: [schema] }, SERVING);

  const [block] = ldJsonBlocks(html);
  assert.deepEqual(JSON.parse(block), schema);
  // A replacement string would have expanded `$&` into the matched </head>.
  assert.equal(count(html, /<\/head>/gi), 1);
  assert.match(html, /<\/script>\n<\/head><body><main>Body<\/main><\/body><\/html>$/);
});

test('several schema blocks keep their order and each parses on its own', () => {
  const first = hostileSchema();
  const second = { '@context': 'https://schema.org', '@type': 'WebSite', name: 'Practice $& Site' };
  const html = injectSeoMeta(WRAPPER, { schema_json: [first, second] });

  const blocks = ldJsonBlocks(html);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((block) => JSON.parse(block)), [first, second]);
});

test('ordinary schema renders byte-identical to plain JSON.stringify', () => {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Dentist',
    name: 'Practice Dental',
    address: { '@type': 'PostalAddress', addressLocality: 'Austin' },
  };
  const html = injectSeoMeta(WRAPPER, { schema_json: [schema] }, SERVING);
  assert.deepEqual(ldJsonBlocks(html), [JSON.stringify(schema)]);
});
