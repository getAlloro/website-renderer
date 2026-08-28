/**
 * First-touch WIRE CONTRACT — the LIVE sender.
 *
 * This is the coverage the alloro-side test explicitly says does not exist:
 * "what is NOT checked, by anything, anywhere — the script actually served to
 * visitors. It is produced in the other repo."  It is produced HERE, so it is
 * checked here.
 *
 * Measured 2026-08-28 before the fix this guards: production held 1,099 form
 * submissions and ZERO with a source, because the emitted script never put the
 * fields on the wire. This script fails if that regresses.
 *
 * No test framework: this repo has none, and adding one to assert a string is
 * not worth a new dependency. It runs on `tsx`, already a devDependency.
 *
 *   npm run check:form-contract      → exit 0 pass, exit 1 fail
 */

import { renderPage } from "../src/utils/renderer";

const FAILURES: string[] = [];

function check(label: string, condition: boolean): void {
  if (!condition) FAILURES.push(label);
}

const html = renderPage(
  "<!doctype html><html><body>{{slot}}</body></html>", // wrapper — must carry {{slot}}
  "", // header
  "", // footer
  [{ name: "body", content: "<form data-form-name='Contact'><input name='Email'></form>" }],
  undefined, // codeSnippets
  undefined, // currentPageId
  "test-project-id",
  "https://api.example.test"
);

// D1 — both first-touch fields reach the wire.
check(
  "D1: payload carries first_touch_referrer",
  html.includes("payload.first_touch_referrer=_ft.r")
);
check("D1: payload carries utm_source", html.includes("payload.utm_source=_ft.u"));

// D2 — the capture runs before submit, and survives a storage failure.
check("D2: first-touch is captured into sessionStorage", html.includes("_alloro_ft"));
check("D2: storage failure cannot break the form", html.includes("catch(_e){_ft=null;}"));

// D3 — the page never sends a pre-classified `source`. Classification is
// server-side (sourceAttribution.ts), where it earns the client_referrer tier.
check("D3: no pre-classified source on the wire", !html.includes("payload.source="));

// D4 — caps match the receiver's bounds so a long value is trimmed here, not rejected there.
check("D4: referrer capped at 2048", html.includes("slice(0,2048)"));
check("D4: utm_source capped at 100", html.includes("slice(0,100)"));

// D5 — the body is the payload object, not a re-inlined literal that would
// silently drop the fields again.
check("D5: fetch body is the payload object", html.includes("body:JSON.stringify(payload)"));

if (FAILURES.length > 0) {
  process.stdout.write(`form-contract FAILED (${FAILURES.length}):\n`);
  for (const f of FAILURES) process.stdout.write(`  ✗ ${f}\n`);
  process.exit(1);
}

process.stdout.write("form-contract: 8/8 checks passed\n");
