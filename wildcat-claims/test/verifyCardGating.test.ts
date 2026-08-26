import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The Foundation's verify section is not part of the lender's task, so it stays out of the page
 * until either the claim is finished or the reader asks for it by fragment. The reveal paths are
 * checked in a browser; what a test can hold still is that the element ships hidden and that the
 * reveal sits where the process actually ends, since a stray `show()` elsewhere would silently
 * put it back on the page for every visitor.
 */
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'app-build', 'index.html'), 'utf8');

describe('the verify section is gated', () => {
  it('ships hidden', () => {
    const el = indexHtml.match(/<details[^>]*id="verifyCard"[^>]*>/)![0];
    expect(el).toContain('hidden');
  });

  it('is revealed only on completing a claim and on the fragment', () => {
    const reveals = [...indexHtml.matchAll(/show\((?:\$\("verifyCard"\)|card)\)/g)];
    expect(reveals).toHaveLength(2);
  });

  it('reveals it where the process ends, right after the receipt', () => {
    const receipt = indexHtml.indexOf('show($("receipt"));');
    const reveal = indexHtml.indexOf('show($("verifyCard"));');
    expect(receipt).toBeGreaterThan(-1);
    expect(reveal).toBeGreaterThan(receipt);
    // Adjacent, not merely later in the file: one comment line between them.
    expect(indexHtml.slice(receipt, reveal).split('\n').length).toBeLessThanOrEqual(3);
  });

  it('parses the fragment without a regex, which is how the first attempt broke', () => {
    expect(indexHtml).toContain('function fragmentFlags()');
    expect(indexHtml).toContain('fragmentFlags().includes("verify")');
    // The bug: an over-escaped \\b matched a literal backslash, so #verify never revealed it.
    expect(indexHtml).not.toContain('verify\\\\b');
  });

  it('still reads the debug key from the same fragment', () => {
    expect(indexHtml).toContain('dbg=');
    expect(indexHtml).toContain('/debug/session');
  });
});
