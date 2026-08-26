import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import {
  QUALIFYING_LENDER_UNDERTAKING,
  QUALIFYING_LENDER_DEFINITION_LIST,
  QUALIFYING_LENDER_AGREEMENT,
  QUALIFYING_LENDER_AGREEMENT_SHA256,
} from '../src/utils';

// The frontend is a single self-contained HTML file that builds its own typed data, so it carries
// its own copy of the undertaking wording. The server rebuilds the digest from its constant, so a
// single character of drift would make every signature the page produces invalid. Pin them together.

const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', 'app-build', 'index.html'),
  'utf8'
);

/** Body of a `const NAME = ...;` declaration in the page's module script. */
function declBody(name: string): string {
  const decl = indexHtml.match(new RegExp(`const ${name}\\s*=\\s*([\\s\\S]*?);\\n`));
  if (!decl) throw new Error(`no \`const ${name}\` found in app-build/index.html`);
  return decl[1];
}

/**
 * Unescape one JS string literal, single- or double-quoted, the way the engine would.
 *
 * Written as an escape-aware scan rather than a requote-and-JSON.parse: a backslash is always
 * consumed together with the character it escapes, so `\\` cannot be mistaken for the start of
 * another escape and a quote of the other kind needs no handling at all.
 */
function unquote(literal: string): string {
  const body = literal.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') {
      out += body[i];
      continue;
    }
    const esc = body[++i];
    switch (esc) {
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '0': out += '\0'; break;
      case 'x':
        out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
        i += 2;
        break;
      case 'u':
        out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
        i += 4;
        break;
      // \\ , \' , \" and anything else escaped stands for the character itself.
      default: out += esc;
    }
  }
  return out;
}

/** Every JS string literal in a declaration, unescaped. Handles both '…' and "…" quoting. */
function literals(src: string): string[] {
  const parts = src.match(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g);
  if (!parts) throw new Error('no string literals found');
  return parts.map(unquote);
}

/** Concatenated literals (`"a " + "b"`) assigned to `const UNDERTAKING`, joined back up. */
function undertakingFromPage(): string {
  return literals(declBody('UNDERTAKING')).join('');
}

/**
 * The page's DEFINITIONS array. Entries are themselves `"a " + "b"` concatenations, so split the
 * literal run on the array's `,`-separated elements by re-parsing the declaration body.
 */
function definitionsFromPage(): string[] {
  return declBody('DEFINITIONS')
    .replace(/^\s*\[/, '')
    .replace(/\]\s*$/, '')
    .split(/,\s*\n(?=\s*['"])/)
    .map((entry) => literals(entry).join(''))
    .filter((d) => d.length > 0);
}

describe('reading the page\'s copy of the text', () => {
  it('unescapes literals containing backslashes, quotes and control escapes', () => {
    expect(unquote(String.raw`'a\\b'`)).toBe('a\\b');
    expect(unquote(String.raw`'it\'s "quoted"'`)).toBe('it\'s "quoted"');
    expect(unquote(String.raw`"tab\there"`)).toBe('tab\there');
    // A trailing escaped backslash must not swallow the closing quote's place.
    expect(unquote(String.raw`'ends with \\'`)).toBe('ends with \\');
  });
});

describe('Qualifying Lender undertaking wording', () => {
  it('is identical in the frontend and the server', () => {
    expect(undertakingFromPage()).toBe(QUALIFYING_LENDER_UNDERTAKING);
  });

  it('carries the same definitions as the server, in the same order', () => {
    expect(definitionsFromPage()).toEqual(QUALIFYING_LENDER_DEFINITION_LIST);
  });

  it('is shown in the page body and again at the point of signature', () => {
    expect(indexHtml).toContain('id="undertakingBlock"');
    expect(indexHtml).toContain('id="undertakingBlockForm"');
    expect(indexHtml).toContain('Definitions &mdash; as used in the undertaking above');
  });

  it('is agreed to by one checkbox that sets both declarations', () => {
    expect(indexHtml).toContain('id="acceptDeclaration"');
    expect(indexHtml).toContain('acceptTerms: $("acceptDeclaration").checked');
    expect(indexHtml).toContain('acceptUndertaking: $("acceptDeclaration").checked');
  });

  it('signs the digest of that text, not the text itself', () => {
    expect(indexHtml).toContain('undertaking: { agreed: form.acceptUndertaking, sha256: agreementSha }');
    expect(indexHtml).toContain('{ name: "sha256", type: "bytes32" }');
    // The page computes the digest over undertaking + definitions, exactly as the server does.
    expect(indexHtml).toContain('const AGREEMENT = [UNDERTAKING, ...DEFINITIONS].join("\\n\\n")');
  });

  it('reads as a lender-side undertaking about the borrower\'s Market', () => {
    // The signer is a lender in someone else's Market, dealing with its default.
    expect(indexHtml).toContain('a Market deployed by the');
    expect(indexHtml).toContain('not as the party that created it');
    expect(indexHtml).toContain('As a Qualifying Lender in this Market');
    // The borrower-facing phrasing from the wider terms must never appear here.
    expect(indexHtml).not.toContain('the Market you have created');
  });

  it('has a digest an outside verifier can reproduce', () => {
    expect(QUALIFYING_LENDER_AGREEMENT_SHA256).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is published byte-exact in examples/, and those bytes hash to the committed digest', () => {
    // What a proof holder actually does: hash the published file, compare to the signed value.
    const bytes = fs.readFileSync(
      path.join(__dirname, '..', 'examples', 'qualifying-lender-agreement.txt')
    );
    const digest = '0x' + createHash('sha256').update(bytes).digest('hex');
    expect(digest).toBe(QUALIFYING_LENDER_AGREEMENT_SHA256);
    expect(bytes.toString('utf8')).toBe(QUALIFYING_LENDER_AGREEMENT);
  });

  it('reads exactly as instructed', () => {
    expect(QUALIFYING_LENDER_UNDERTAKING).toBe(
      'As a Qualifying Lender, you acknowledge and agree that by receiving any information ' +
        "relating to the Borrower's Identifying Particulars, you shall not use that information " +
        'for any purpose other than (i) in connection with the Market in respect of which that ' +
        'information was disclosed to you and (ii) to pursue any legitimate course of action ' +
        'arising therefrom.'
    );
  });
});
