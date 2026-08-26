import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { QUALIFYING_LENDER_UNDERTAKING } from '../src/utils';

// The frontend is a single self-contained HTML file that builds its own typed data, so it carries
// its own copy of the undertaking wording. The server rebuilds the digest from its constant, so a
// single character of drift would make every signature the page produces invalid. Pin them together.

const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', 'app-build', 'index.html'),
  'utf8'
);

/** Concatenated JS string literal (`"a " + "b"`) assigned to `const UNDERTAKING`, joined back up. */
function undertakingFromPage(): string {
  const decl = indexHtml.match(/const UNDERTAKING\s*=\s*([\s\S]*?);\n/);
  if (!decl) throw new Error('no `const UNDERTAKING` literal found in app-build/index.html');
  const parts = decl[1].match(/"((?:[^"\\]|\\.)*)"/g);
  if (!parts) throw new Error('`const UNDERTAKING` is not a string literal');
  return parts.map((p) => JSON.parse(p) as string).join('');
}

describe('Qualifying Lender undertaking wording', () => {
  it('is identical in the frontend and the server', () => {
    expect(undertakingFromPage()).toBe(QUALIFYING_LENDER_UNDERTAKING);
  });

  it('is shown in the page body and gated by its own checkbox', () => {
    // Displayed twice: the standing card in the page body, and again at the point of signature.
    expect(indexHtml).toContain('id="undertakingText"');
    expect(indexHtml).toContain('id="undertakingTextForm"');
    // Agreed to explicitly, and carried into the signed typed data.
    expect(indexHtml).toContain('id="acceptUndertaking"');
    expect(indexHtml).toContain('undertaking: { agreed: form.acceptUndertaking, text: UNDERTAKING }');
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
