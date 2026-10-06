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
      // Tree construction, not just tokenization: the parser inserts the tbody a browser inserts,
      // so the allowlist is asked about the element that actually ends up in the DOM.
      'an implied tbody is inserted',
      '<table><tr><td>a</td></tr></table>',
      [{ tag: 'table', attrs: [] }, { tag: 'tbody', attrs: [] }, { tag: 'tr', attrs: [] }, { tag: 'td', attrs: [] }],
    ],
  ])('%s', (_label, html, expected) => {
    expect(parseTags(html as string)).toEqual(expected);
  });
});
