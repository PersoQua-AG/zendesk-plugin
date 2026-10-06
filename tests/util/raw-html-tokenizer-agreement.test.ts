// tests/util/raw-html-tokenizer-agreement.test.ts
// The differential proof the hand-written checks could not give (#60). Branch coverage cannot show
// it: every pass QA found ran through covered branches, because the question is never "did this
// line execute" but "does our view of the markup match the browser's". So this asserts the view
// itself — the elements and attributes parseTags reports — against expectations derived by hand
// from the WHATWG tokenizer rules, case by case. If the parser's view ever drifts from the spec
// reading written out here, these fail; that is the thing the previous two rounds could not detect.
import { describe, it, expect } from 'vitest';
import { parseTags } from '../../src/util/raw-html.js';

describe('the parsed view matches the HTML tokenizer, case by case', () => {
  it.each([
    [
      // Round 2 killer. In an UNQUOTED value a `"` is a parse error and stays literal, so `alt` is
      // `a"` and the next attribute's quote opens a value rather than closing one. The hand-written
      // scanner read it the other way round and ended the tag inside src.
      'a stray quote in an unquoted value',
      '<img alt=a" src="b>c" onerror=alert(1)>',
      [{ tag: 'img', attrs: [['alt', 'a"'], ['src', 'b>c'], ['onerror', 'alert(1)']] }],
    ],
    [
      // Round 1 killer. In a QUOTED value a `>` is ordinary content; the tag runs on to the real `>`.
      'a > inside a quoted value',
      '<img src="https://x.test/a.png" alt="a>b" onerror=alert(1)>',
      [{ tag: 'img', attrs: [['src', 'https://x.test/a.png'], ['alt', 'a>b'], ['onerror', 'alert(1)']] }],
    ],
    [
      // `/` between attributes is a separator, not the start of a self-closing marker.
      'a slash used as an attribute separator',
      '<img/src=x onerror=alert(1)>',
      [{ tag: 'img', attrs: [['src', 'x'], ['onerror', 'alert(1)']] }],
    ],
    [
      // Character references ARE resolved in attribute values, so the scheme is real here.
      'an entity-encoded scheme resolves',
      '<a href="java&#115;cript:alert(1)">x</a>',
      [{ tag: 'a', attrs: [['href', 'javascript:alert(1)']] }],
    ],
    [
      // ...but `&amp;` yields a literal `&`, so this value is the relative URL `javascript&#58;...`.
      // The URL parser does not decode character references, so no browser navigates a scheme here.
      'a double-encoded colon does NOT resolve to a scheme',
      '<a href="javascript&amp;#58;alert(1)">x</a>',
      [{ tag: 'a', attrs: [['href', 'javascript&#58;alert(1)']] }],
    ],
    [
      'tag and attribute names are ASCII-lowercased',
      '<IMG SRC=x ONERROR=alert(1)>',
      [{ tag: 'img', attrs: [['src', 'x'], ['onerror', 'alert(1)']] }],
    ],
    [
      // Whitespace ENDS an attribute name, so this is two attributes (`on`, `error`), not one
      // `on\nerror`. The handler rule still catches it, because `on` itself starts with "on".
      'a newline inside an attribute name splits it in two',
      '<img src=x on\nerror=alert(1)>',
      [{ tag: 'img', attrs: [['src', 'x'], ['on', ''], ['error', 'alert(1)']] }],
    ],
    [
      // `<` before a non-letter never opens a tag; it is text.
      'a bare < in text opens nothing',
      '<p>use 5 < 6 here</p>',
      [{ tag: 'p', attrs: [] }],
    ],
    [
      'the desynchronising quote on a table cell',
      '<td alt=q" title="x>y" onmouseover=alert(1)>z</td>',
      [{ tag: 'td', attrs: [['alt', 'q"'], ['title', 'x>y'], ['onmouseover', 'alert(1)']] }],
    ],
    [
      // The token stream carries no implied tbody — the tree builder adds that, and the
      // document-view test below is where it is asserted.
      'a table start tag carries no implied tbody in the token stream',
      '<table><tr><td>a</td></tr></table>',
      [{ tag: 'table', attrs: [] }, { tag: 'tr', attrs: [] }, { tag: 'td', attrs: [] }],
    ],
    [
      // THE EMPTY EXPECTATION. `[]` is the most dangerous answer this function can give, and not
      // asserting it anywhere is how the <body> pass survived: the fragment parser returned [] for
      // `<body onclick=…>` and nothing demanded to know when "nothing" is the right answer. Here
      // nothing is right, because there is no markup at all.
      'text with no markup yields no elements at all',
      'just words, no markup',
      [],
    ],
    [
      // ...and here nothing would be WRONG, which is why it is a token and not a tree question.
      // "in body" ignores a <body> start tag outright, so a fragment parse sees no element; a page
      // merges these attributes onto its own <body>. The token stream states what was written.
      'a <body> start tag is a real token even where an insertion mode would drop it',
      '<body onclick=alert(1)>',
      [{ tag: 'body', attrs: [['onclick', 'alert(1)']] }],
    ],
  ])('%s', (_label, html, expected) => {
    expect(parseTags(html as string)).toEqual(expected);
  });
});

// Why the check reads tokens and not a tree, stated as the three ways the two disagree. A tree view
// was carried alongside for one round and removed as redundant; the REASON must stay pinned, or the
// next person builds a parseFragment check and brings round 3 back.
//
// 1. the tree builder IMPLIES a tag the token stream lacks (tbody) — benign, it is on the allowlist
// 2. an insertion mode MERGES attributes onto an element that already exists (html, body)
// 3. an insertion mode DROPS the tag outright, so NO tree shows it at all
//
// Only the token stream survives all three, and 2 and 3 are the dangerous ones.
describe('the token stream is what survives every insertion mode', () => {
  it('an implied tbody is the only thing a tree adds, and it is allowed anyway', () => {
    expect(parseTags('<table><tr><td>a</td></tr></table>').map((t) => t.tag)).toEqual(['table', 'tr', 'td']);
  });

  it.each([
    ['frameset', '<frameset onload=alert(1)>', 'frameset'],
    ['head', '<head onclick=alert(1)>', 'head'],
    ['frame', '<frame src="https://evil.test">', 'frame'],
    ['col outside a table', '<col onclick=alert(1)>', 'col'],
    ['caption outside a table', '<caption onclick=alert(1)>x</caption>', 'caption'],
  ])('%s is a token no tree mode builds, and the token stream still has it', (_label, html, tag) => {
    expect(parseTags(html as string).map((t) => t.tag)).toEqual([tag]);
  });

  it('plain text contains nothing, and nothing is the right answer there', () => {
    expect(parseTags('just words, no markup')).toEqual([]);
  });
});
