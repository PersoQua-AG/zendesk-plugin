// tests/util/raw-html-tokenizer-agreement.test.ts
// The differential proof the hand-written checks could not give (#60). Branch coverage cannot show
// it: every pass QA found ran through covered branches, because the question is never "did this
// line execute" but "does our view of the markup match the browser's". So this asserts the view
// itself — the elements and attributes parseTags reports — against expectations derived by hand
// from the WHATWG tokenizer rules, case by case. If the parser's view ever drifts from the spec
// reading written out here, these fail; that is the thing the previous two rounds could not detect.
import { describe, it, expect } from 'vitest';
import { parseTags, documentElements } from '../../src/util/raw-html.js';

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

// The fragment-vs-document contrast itself, which neither of the earlier rounds measured. An article
// body is not rendered as a fragment; it is inserted into a page. Where the two modes disagree, the
// DOCUMENT mode is the one that describes the delivered context — and the token stream is what
// survives both. These assert the disagreement rather than assuming it away.
describe('the two parse modes are compared, not assumed equal', () => {
  it('the document parse adds the tbody the token stream does not have', () => {
    const html = '<table><tr><td>a</td></tr></table>';
    expect(parseTags(html).map((t) => t.tag)).toEqual(['table', 'tr', 'td']);
    expect(documentElements(html).map((t) => t.tag)).toEqual(['table', 'tbody', 'tr', 'td']);
  });

  it('a <body> start tag is a token, and the document parse shows it merging onto the page body', () => {
    const html = '<body onclick=alert(1)>';
    expect(parseTags(html)).toEqual([{ tag: 'body', attrs: [['onclick', 'alert(1)']] }]);
    // Not "an attribute on <body>": the scaffold contributes a bare <body>, so an attribute found
    // there is one the host page would adopt onto its own element.
    expect(() => documentElements(html)).toThrow(/merges onto its own <body>/i);
  });

  it('both modes agree that plain text contains nothing', () => {
    expect(parseTags('just words, no markup')).toEqual([]);
    expect(documentElements('just words, no markup')).toEqual([]);
  });
});
