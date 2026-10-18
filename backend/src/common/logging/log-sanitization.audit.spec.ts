import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

/**
 * Repository-wide audit for the "sensitive data is never logged" acceptance criterion.
 *
 * Redaction is enforced structurally — every production log call goes through
 * `SanitizedLogger`, which scrubs each argument — so this suite guards the *structure* rather
 * than trying to re-derive the policy. It fails if someone reintroduces a raw `new Logger(...)`
 * in production code, because that single change would silently opt a file out of redaction.
 *
 * A grep-based test is used rather than a runtime one on purpose: a runtime test can only
 * observe log calls that some test happens to make, and would happily pass while a
 * never-exercised controller still logged a raw request body.
 */

const SRC_ROOT = resolve(__dirname, '..', '..');
const LOGGING_DIR = resolve(SRC_ROOT, 'common', 'logging');

/** Recursively collect every `.ts` file under `src`, excluding tests. */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

const sourceFiles = collectSourceFiles(SRC_ROOT);

describe('log sanitization audit', () => {
  it('finds source files to audit (guards the audit itself against silently matching nothing)', () => {
    expect(sourceFiles.length).toBeGreaterThan(50);
  });

  it('no production file constructs a raw Nest Logger', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      // The sanitizer itself legitimately wraps Nest's Logger; everything else must not.
      if (resolve(file).startsWith(resolve(LOGGING_DIR, 'sanitized-logger.ts'))) continue;

      const source = readFileSync(file, 'utf8');
      if (/\bnew\s+Logger\s*\(/.test(source)) {
        offenders.push(file.replace(SRC_ROOT, 'src'));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no production file calls console.* (bypasses the sanitizer entirely)', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8');
      if (/\bconsole\.(log|warn|error|debug|info)\s*\(/.test(source)) {
        offenders.push(file.replace(SRC_ROOT, 'src'));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no production file logs a full request/response body', () => {
    const offenders: string[] = [];
    // A body is only ever unsafe if it is logged by reference; `req.body` / `request.body`
    // reaching a log argument is the pattern to block.
    // The 'headers' pattern must match actual header object variables (req.headers, response.headers)
    // not just the word 'headers' appearing in a string literal or comment.
    const bodyPatterns = [
      /logger\.\w+\([^)]*\breq\.body\b/,
      /logger\.\w+\([^)]*\brequest\.body\b/,
      /logger\.\w+\([^)]*\breq\.headers\b/,
      /logger\.\w+\([^)]*\bresponse\.headers\b/,
      /logger\.\w+\([^)]*\bheaders\s*[,)]/,
    ];

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8');
      if (bodyPatterns.some(pattern => pattern.test(source))) {
        offenders.push(file.replace(SRC_ROOT, 'src'));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('no production file passes an environment secret into a log call', () => {
    const offenders: string[] = [];
    // Match the *direct* form: a secret env var read appearing inside a logger call's
    // arguments. Indirection (`const t = process.env.X; logger.log(t)`) is covered by the
    // SanitizedLogger's value-shape redaction at runtime, so this test targets the
    // unmistakable case rather than trying to be a dataflow analysis.
    const secretNames = [
      'JWT_SECRET',
      'JWT_SECRET_PREVIOUS',
      'DB_PASSWORD',
      'SENTRY_DSN',
      'IPFS_INFURA_PROJECT_SECRET',
      'IPFS_PINATA_JWT',
      'WEBHOOK_SECRET',
    ];
    const directRead = new RegExp(
      `process\\.env\\.(${secretNames.join('|')})\\b|\\$\\{[^}]*\\b(${secretNames.join(
        '|',
      )})\\b[^}]*\\}`,
    );

    for (const file of sourceFiles) {
      const source = readFileSync(file, 'utf8');
      // Isolate each logger call's argument text, then test only that.
      const calls = source.match(/logger\.\w+\([\s\S]*?\)\s*;/g) ?? [];
      if (calls.some(call => directRead.test(call))) {
        offenders.push(file.replace(SRC_ROOT, 'src'));
      }
    }

    expect(offenders).toEqual([]);
  });
});
