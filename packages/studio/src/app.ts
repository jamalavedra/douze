/**
 * #ReviewApp — one file, no framework, no build step. Inlined so `tsc` needs no asset-copy step
 * and douzed needs no __dirname lookup. Skills are grouped by consequence; technical evidence
 * stays behind one disclosure.
 */
const BRAND_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAAAAAAAAPlDu38AAAAHdElNRQfqCAcLJwLuMt2UAAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA4LTA3VDExOjM5OjAyKzAwOjAwOMS9kwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wOC0wN1QxMTozOTowMiswMDowMEmZBS8AAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDgtMDdUMTE6Mzk6MDIrMDA6MDAejCTwAAAQNElEQVRo3u2ZeZRcVZ3HP79773tVXd2dTkKSDrtgIIQhbJGgQUWYxCi7ceDI4gHBMQcHFVdQkRF0GPQMojiCKKtGRtEZdsMmmyGEYAgkgYEQgkkwpDtJpzu9Vb337v3NH+9VdXUSOfwz/3HPqap3331172/9/pYH7453x///ECco10A7RLFDSkAJJBZsbKEFqOTzdzqi2IGFfT8zCSOCRIJYQZyAFPtYMJF5e9rebjGOInzwmBDAQIaxRLHgIlBAA5qliM8AVRGCKpovgjEOn2aN/WzsCMGje7QTbRok80FQtWNU2F+FyYh2o7wmKv0CRsTHzmrIAikBVAghvDMJGWMxVpCcS3HHn2Hq3Mrf4VyAynMqBowBjBGcs7goQqwwtrE59hCMxQIm/+MeCDMw7IUZOcBBRcRhRTAgRjDOjjrT7ZJ461D1qFeKI4I+dqcCHxc4KDcYnECq0Ad0A38VWMeLz3WTq0BQVR8UyFCUXot0BLF9aNaVH9UJHINwVI+wd79qpQbDCG8CzwGPDqG9CBCwquqj4PFRhE/TXZuQsQZVRYMWVoiPpxxBtmb59fLZf7uQg2dCdQixFvUZ2Ajd/CaycQ3atb5fXlq8WjZtOEtgdbBiCASPgmAxeDwgHOGQb/wT7qQjkbZ/wNCJMF6hKrCawCqUhep7nsbfQsQVZAygOJSsDNQig6ZhZ+LFNpzGAVQu+jEG7rDf/pW6655M7W0vp+4FTd2zmrrnNHXfvyt1/9OVuRUa3Asa7Nd/qQIXAUgUu8IcHAbowGD4yXkm0qdNWZdJWdW0ZmpaUzWt6cumJVttymkxz9S06gJT0n3FbMRwVGMvwFjBRIYGteIMIaqgPgBEQAaY6n9e/JD593vPNNak5qZvOfvW644+HL2Jsz3Dzr621IVL5lpd8brgyWgdA+ABrLV1QWRA54Tt5vnfUf7ircR6vfjscqe6WdQmGlwQ3ENW7FxS96R6B9gqqmfjkmektPtRap/FMBMhw+ACiipQKseIFequITnxABNlzPgX7I+f0HiJJuaah5UHvfKkavSYavyUKg/WlMdUWfCKuh89rG6lpvbSWxX451yHtoQBDJ1TxG540bSomtbaI66ij1JSBVVKWnNtqpRVQbuJ9GZbVjUVrZmKDpqKqmlNuk1FpxjTTcw4HOByrDVJmoJXAojstnukkAJHyn6HrDLXLTrMzDo2TYaJSpU2LnvtZk584mekw4MkXW9xyvLb+MGqG9ht0+tkR81Bhij8l6oBVCemtGH3wDxyr8R7HYpJ+oV4dpZSaatw3Wmf4E9j2oizQR7saOO6c89j0R6TOd97EsnNI0YYQqOJSHIt8UQyriGDyVlhPbmAkJKqFOh1pvnACWrv61W3WNP4SVVufF5/9193qKqq9nZr25W/01Ov/bVqtU9VVW+49VfK7a9peYVm9qs/V+DMhj6N/PxeU1Y1rbXtplXVtOoTUtL/XvhHVVVdeOONeivo40uWqKrqA08+oc9gVG2r1kyrpsVnONeEzjNOsRyIBawYQx73NP3SLxS4Ws74yh3mhw8gYzq86a+5xMOx21/ijE+dyZp1G1j26lo+1LOC784+EkpjWPP6WmZOnwbbu/AWSJOGD2D1g1/AzT8ZE4bQuGIttTDIG6fPY97HPk7PW5vIxo9n7cUX85Gjj6bnzb9x+IwZbHnP/uBr5CLVulYBsrNwoJxDgErAmgg0Asft37rffP3mS8wl13hqGqil1sQl6O1j1sQKAJ//3Gf54pe/wrj+bg4/5GC+c9llXPCZ81i7bgNUxoAHzRIcJAcCnWou+2IOGsEqWIQuoHP28QCcdNqp/PSXv+TEs87itVdf5dg5s3n66adpi0tAaCa88FGVD2LYD/OxVCsMamtmUiCB3eXw407knPOVzTUDajCFW4tSivPrZcueZ/HiJXS1dwJw22/uYP1rr/DUG10wfm9MhuA9bdCz+sCpnZ/AzJ2CMAzOiIAoAShVWti6rYdnli7lyUceYY+xY7n33ntZ9corrFq6lM6Nb+XWrzkDWoSrFEwncBByQOSGxosbUCsHv9+S1XpZu2KqHPzR6bLPvp7EG4yBEPBtFbauWMqF0yczMRLub53KtsPn8o39SoyZMAk3PMAj005h217TMA7Vvzwh7vnHrkuq1aO/kuknp6vJvOSpRUDoCAmLqikHX3A+bw0OcMzixex95AymfvxjvLrxbxz15lscv3I54lqgYKCeWQTAIfIYIV6u4WaUHsPLS9Btm9EkuSrc8zNwODTPxwJCFGDl9FM44vqHWNAxA/uFn7LtgA8x99aHaZu8Fys/+GnWHnAccfAEgCyhH9I4hOnvbQIKAfAea1uZ+8eF4anj56SfW/Rs+AmG/q9dyoY//5n5++7PR++5n7JpJQu+QXjdkFQRRGhBDFBGQVqAZNI+TrvXZwq3mZ8sOldmHpPRnzlQsE6NE0ly9rHVgBFIkwRsBM/cQ7RlPeGTFyNtaLjum9L+66sP6qtUPnJTNfv5BUS1AbRUBjKFsojvE+wiP8gMYLJt09QnspGEycDVJuYMHNMUUhmd62SgZTFygdb0Fk0PAlYbF4/Dd68PhctcGf5wjUdxhBAYG3mSqgSvxOteInr2UaTdIG2G8tgybtWfcL/5HuEDJyO+yEu8J4GWh4eGbvw26Qt/wZfakGSInPhnCPZ9OvzySS2li2Y59+IbIZPIlcK+5XHcFLWwmsA06sRLw4AUyfWpyia0H0NPrlqX82hKLa6ICde6q+5Tt1KDveJONZP2HHDfvyu45armomvVTj9GmXOOMm2mtoPaY09Xt0zVLhxSt1TVnP4lBQ4DIGa3yUZWPGBKqqatutFUdE9jVhHTggEsR5xinP4IwqwCL283eRQeMpVGDEhNqyZ5DPGb84j8otKJcggYZwCHBbE5XI0zU2dsMf/4KRX4qsCF9rIF6pZrFt2zWQE9fsw4XfeZr+stc09XbnhO40Wq7sFqcEtVzbzPKzBtXD0LaiHGcMd3TVQPQofWXWP6mPa9geqkcRP07rMvDlfNmqtrMKq2TWs7MFDNGUjvN2XF8CMEOkScC1lAnCIZmtddbNNXlx3Nq8ti4H8FLsBGUEN1wgSYfzVfWv8iXcFz+czT4ND3oYNZXsIo4LMA+G05/kUkJONUzvqupL8BMjwrEMpA9aWB/g9PECndNe+zfmJbuzUP/Jb3EpGoYnbI9BUFjLkzj5F3ItAnqGuEfAdkGgrQeL3h+VAxLs7D9WCKPfsSTl21FKISHHQY0VAgiIHgkQDqvc8hG2LEJ6gcg5H78Q8UR1nKVDkOOexB+50/mBIv/OFW6e/fzonBkxmHFPVQfXiUMpItx7vfkj0+JZglszDmrihPW9Es4F3D5YMYMURlp9XhRMBJnhbnyzWPO3QmRkGrniCCKI1CXNJENYdsUgSM0fsd6lKxGTBbrTw67OFBbriCeOr+gWz/vl6HWDIb1bFyRHyNa7FXkpKg31xjlDUEETEjJaVmI2E7qrSHFBOkOpxHcVsU8RQdg6GMgKBGRuG0KJAlPkc8IOSmEKeeKvhIJHpUshThwu9Tmn8yxg+JOitF3dNEvJJfJygVJLmBNL6b7BoCzwo4hQyv7LJnIVkGYuqEteTu3VgFY1EjoI1gOSKw3AdCI/RooJojYZSiKcKc84mu/zaOBDURYFEMTUZbJA9pTny6lBB/meQvGtq/xkTQSPKKR8yuGUizGti4PnXqYurNklG54Y7tiQAQRjQgQsjrYYeQIhw4B3ffTcQENDQZXuO7vncKtEC2UTT6FLWtNdGTxfTDViyqGmJDlvldMxDEg3P17WOsbU4Md9aYgEihkSzL6gwUfRhTzMsHYBf+mrgkaJYWrReljjAjMkk1J74H3Alarb0h4TiUTeRQ40WFkATicmnXDESmHayFKEaN2LoT162iuT9UNyMtrsVnGUU9YIxwWnCyWzCA3H4j0f6dkA7DDt2dEfkkQItI1g1utlbTFwkfJrASpVxGNBJxpSiipRwjwe+6L6RW8zzHxYiGGNv0mIyAXLNSBMlNKG/FeYDUB3e3hBThzCsonXEcNhtGo4gRfJGmHXxu834Nwc2j1rtSwoeBlXlnimq1OPH9LmZAAy9rumsGQrUKLkJcCXwSI4UJychxo/ygfktV8H7EiR0pUD4qsz+8BEtAjWvYu47aIKCUkLAYb0+ltnKL6EnqO9eL7doLaEeYBOwJpBNddBchy8Q3MSBWmiQcoDZstDIG0mFLUxyow5vuRL9ACKAhAyjN+3ypdvf1NYRzL8TtVVLSYSGK2HkoSgxsAzlPEyIRZqv9/Qlm676fVleZiLSPQ3gPwkMEFvRvm4dyl0XciAbEolk2QtqmvyYCSMcEn6ffo0U+inA0106WoWkybC65cbj2g/n8h8T8guzTJ2CgIf3RUbauS0/e4F4iZRWYHgFto07SACYZiy8vIN0HIKa5NyratB1GYBoQ0bflQOJSXt3scPQoY9IgxCXERbvrD+ZfVYENXzPJ02erO6QToVZUZbsadbYsyvickhDIoTSoigriwbSiLsmPFMjr5BEGVDBjJzoG+zKC/1fmnHO57DMVJu+H7DlFSdTmeFkQrSPkF6YlAmouXTBWN6/7pn/+cbjl8vsOs9aiUl9vIndnLVAQDSPoaHYoaoo+q0dzrY0wYED2PBD6tkDvpvdy7pUwfZ+EfiIdVBmdYDWH+/odAz4Ik/ZWOXjvjLgSccvlE8YjMTt5jIwivHn17dmD4Vx4AyhkQnNv1BG2vInvegM/tL2b7g2wDUNfTUSKbjlF6qAj4X4nMpJE6Mfplg0AfTLKgXaIhm8THHXXj8i2/EZvXRsNDYShKmJ6IU0Q2KyDvUh9NYRRO+147ihGQsjRdqAPYMN2IUNxWcMudrC9t+Gnee6Lo7bmCN2Tr4s2GDAtJagN1add1IaQDjJ8qdFWaBCqhaqbXKIBRt5BB0p1MAKWrRA9A6TchqT5U8XDMioMSrNfsVO4EeL8VNmaT7sKekYYoCWGvkEt/ruOZY8S9phSZqC3yFpklKi1Dp2FdzQEqwHaOggr/wzw1O9Ff9upyfxZYqMWhApQApwqkQiCYAmN/bXJID15JyMVJUUYIPAsYSvCukKQOsJr7DA+E1duVRWJ/cDAvwSYDPXdG6Jq8FCwJM2CK+7HCmuBn2r7CcjgH+cCU1HGiUh7SbUSCRWHRAKRUVyzMotPCEKSQZaqVhNkUEVrwEICTxQWGRoM2DiGLME4Bwg+SXmH7wP/7rh6xnFcuuzx/KiCyxJChyptCG0itGCoEKgXkr5IqWoKQyj9qvSjDIhQResturoFj3YjYwXjcyVqueJCW0dTf7JJ/nXLlPxLd4QKEejvwVSHMx85rM9sWUUq5G8H2zT/bRXRFjW0imKLbeuJVAIMKgyiMoAyJEI/Sq+gJuS1cM3tUPobY4hcGREhC2keEiVHlQI5c+KauVAa/ldfCaqNGkFV8d6DEWxR5amGouug4ECzJmCoC8EUrp2/FERD/soq8xnjKuPpHd6G6tvg8Lvj3fHOxv8B/VfIkHi/JNkAAAAASUVORK5CYII='

export const reviewPage = (session: { id: string; token: string }): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Review your Douze skills</title>
<style>
${STYLE}
</style>
</head>
<body><main>
<header class="hero">
  <div class="brand"><img class="brand-icon" src="${BRAND_ICON}" alt="" /><p class="eyebrow" id="eyebrow">Douze</p></div>
  <div aria-live="polite">
    <h1 id="title">Review your skills</h1>
    <p class="sub" id="sub">Working out what this site can do&hellip;</p>
  </div>
</header>
<div class="toolbar" id="toolbar" hidden>
  <p><strong id="count">0 selected</strong></p>
  <div class="selection-actions">
    <button type="button" class="quiet" id="all">Select all</button>
    <button type="button" class="quiet" id="none">Clear</button>
  </div>
</div>
<div id="groups"></div>
<div class="actions" id="actions" hidden>
  <p>Runs only when you ask.</p>
  <button type="button" class="primary" id="go" disabled>Choose a skill</button>
</div>
<section class="success" id="after" hidden aria-live="polite">
  <span class="success-mark" aria-hidden="true">&#10003;</span>
  <div>
    <h2>Skills added</h2>
    <p id="success-copy"></p>
    <button type="button" class="quiet" id="back">Review selection</button>
  </div>
</section>
<p id="error" role="alert"></p>
</main>
<script>
const SESSION = ${inline(session.id)};
const TOKEN = ${inline(session.token)};
${SCRIPT}
</script>
</body>
</html>
`

/** A stale review link and an empty capture use the same calm shell. */
export const noticePage = (headline: string, next: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeText(headline)}</title>
<style>
${STYLE}
</style>
</head>
<body><main><section class="notice">
<img class="notice-icon" src="${BRAND_ICON}" alt="" />
<h1>${escapeText(headline)}</h1>
<p class="sub">${escapeText(next)}</p>
</section></main></body>
</html>
`

const STYLE = `  :root {
    color-scheme: light dark;
    --bg: light-dark(#f7fbfc, #080a0b);
    --surface: light-dark(#ffffff, #111517);
    --surface-soft: light-dark(#edf7fa, #182124);
    --fg: light-dark(#080a0b, #ffffff);
    --muted: light-dark(#596267, #aeb9bd);
    --line: light-dark(#d8e5e8, #2a393e);
    --accent: light-dark(#008bad, #56d9f5);
    --brand-blue: #00bce8;
    --brand-red: #f31b1b;
    --safe: light-dark(#007d9e, #56d9f5);
    --changes: light-dark(#d91b1b, #ff6b6b);
    --danger: light-dark(#b70808, #ff6b6b);
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--fg); margin: 0;
    font: 15px/1.55 ui-rounded, system-ui, -apple-system, sans-serif;
  }
  main { margin: 0 auto; padding: 52px 0 72px; width: min(620px, calc(100% - 32px)); }
  h1, h2, p { margin-top: 0; }
  h1 { font-size: clamp(28px, 6vw, 36px); letter-spacing: -.035em; line-height: 1.12; margin-bottom: 10px; }
  h2 { font-size: 16px; line-height: 1.35; margin-bottom: 3px; }
  .hero { margin-bottom: 28px; }
  .brand { align-items: center; display: flex; gap: 10px; margin-bottom: 14px; }
  .brand-icon { height: 42px; object-fit: contain; width: 42px; }
  .eyebrow { color: var(--brand-red); font-size: 13px; font-weight: 700; margin: 0; }
  .sub { color: var(--muted); font-size: 15px; margin: 0; max-width: 560px; }
  .toolbar { align-items: center; border-bottom: 1px solid var(--line); display: flex; gap: 16px; justify-content: space-between; margin-bottom: 30px; padding: 0 0 14px; }
  .toolbar p { margin: 0; }
  #total { color: var(--muted); margin-left: 5px; }
  .selection-actions { display: flex; gap: 4px; }
  .group { margin: 0 0 30px; }
  .group-heading { margin: 0 0 10px; }
  .group-heading p { color: var(--muted); font-size: 13px; margin: 0; }
  .group-count { color: var(--muted); font-size: 13px; font-weight: 500; }
  ul { display: grid; gap: 10px; list-style: none; margin: 0; padding: 0; }
  .skill { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; transition: background-color .18s ease, border-color .18s ease, opacity .18s ease; }
  .skill:has(input:checked) { border-color: light-dark(#a8dce8, #326372); }
  .skill:has(input:not(:checked)) { background: var(--surface-soft); opacity: .5; }
  .head { align-items: flex-start; display: grid; gap: 12px; grid-template-columns: 40px 1fr; }
  .skill-copy { padding-top: 6px; }
  .desc { font-size: 15px; font-weight: 650; margin: 0; }
  .full-desc { color: var(--muted); font-size: 13px; margin: 8px 0 0; }
  .meta { align-items: baseline; color: var(--muted); display: flex; flex-wrap: wrap; font-size: 12px; gap: 6px 10px; margin: 8px 0 0; }
  .name { color: var(--muted); font-family: ui-monospace, monospace; font-size: 12px; font-weight: 400; }
  .warn, .consequence { font-size: 13px; margin: 5px 0 0; }
  .warn { color: var(--muted); }
  .write .consequence { color: var(--changes); }
  .destructive .consequence { color: var(--danger); }
  .toggle { align-items: center; cursor: pointer; display: inline-flex; flex: 0 0 40px; height: 40px; justify-content: center; }
  .toggle input { accent-color: var(--brand-blue); cursor: pointer; height: 22px; margin: 0; transition: transform .14s ease; width: 22px; }
  .toggle:active input { transform: scale(.9); }
  .sr-only { clip: rect(0, 0, 0, 0); clip-path: inset(50%); height: 1px; overflow: hidden; position: absolute; white-space: nowrap; width: 1px; }
  details { margin: 8px 0 0 52px; }
  details:not([open]) > :not(summary) { display: none; }
  details[open] > :not(summary) { animation: details-in .2s cubic-bezier(.2, .7, .2, 1) both; }
  summary { align-items: center; color: var(--muted); cursor: pointer; display: flex; font-size: 12px; min-height: 32px; width: fit-content; }
  pre { background: var(--surface-soft); border-radius: 8px; font-size: 12px; margin: 8px 0 0; max-height: 220px; overflow: auto; padding: 12px; }
  .actions { align-items: center; border-top: 1px solid var(--line); display: flex; gap: 20px; justify-content: space-between; margin-top: 10px; padding: 24px 2px 0; }
  .actions p { color: var(--muted); font-size: 13px; margin: 0; }
  .primary {
    background: var(--brand-blue); border: 1px solid transparent; border-radius: 999px; color: #061014;
    cursor: pointer; flex: 0 0 auto; font: inherit; font-weight: 700; min-height: 44px; padding: 9px 20px;
    transition: filter .16s ease, transform .16s ease;
  }
  .primary:not(:disabled):hover { filter: brightness(1.06); transform: translateY(-1px); }
  .primary:not(:disabled):active { transform: translateY(0) scale(.98); }
  .primary[disabled] { background: var(--surface-soft); border-color: var(--line); color: var(--muted); cursor: not-allowed; }
  .quiet { align-items: center; background: none; border: 0; color: var(--accent); cursor: pointer; display: inline-flex; font: inherit; font-size: 13px; min-height: 40px; padding: 8px; transition: color .16s ease, opacity .16s ease; }
  .quiet:hover { text-decoration: underline; }
  .quiet:disabled { color: var(--muted); cursor: default; text-decoration: none; }
  .success, .notice { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 24px; }
  .success { align-items: flex-start; display: flex; gap: 14px; }
  .success:not([hidden]) { animation: success-in .26s cubic-bezier(.2, .7, .2, 1) both; }
  .success h2 { font-size: 20px; margin-bottom: 5px; }
  .success p { color: var(--muted); margin-bottom: 10px; }
  .success-mark { align-items: center; background: var(--surface-soft); border-radius: 50%; color: var(--safe); display: inline-flex; flex: 0 0 34px; font-weight: 800; height: 34px; justify-content: center; }
  .notice-icon { display: block; height: 54px; margin-bottom: 16px; object-fit: contain; width: 54px; }
  #error { color: var(--danger); font-size: 13px; margin: 14px 0 0; }
  [contenteditable] { border-bottom: 1px dashed transparent; cursor: text; outline: none; }
  [contenteditable]:hover { border-bottom-color: var(--line); }
  [contenteditable]:focus { border-bottom-color: var(--accent); border-bottom-style: solid; }
  :focus-visible { border-radius: 2px; outline: 2px solid var(--accent); outline-offset: 2px; }
  [hidden] { display: none !important; }
  @keyframes details-in { from { opacity: 0; transform: translateY(-4px); } }
  @keyframes success-in { from { opacity: 0; transform: translateY(6px); } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
  }
  @media (max-width: 560px) {
    main { padding-top: 34px; }
    .actions { align-items: stretch; flex-direction: column; }
    details { margin-left: 0; }
    .primary { width: 100%; }
  }`

const SCRIPT = `
const GROUPS = {
  read: { title: 'Look things up', detail: 'Read-only.' },
  write: { title: 'Make changes', detail: 'Creates or updates data.' },
  destructive: { title: 'Remove things', detail: 'Always asks first.' },
};
const WARNINGS = [
  ['sparse', 'Only seen once'],
  ['derived_name', 'Name is a guess'],
  ['unverified', 'Not checked yet'],
];

let state = null;
let seeded = false;
const chosen = new Set();

const el = (tag, props, children) => {
  const node = Object.assign(document.createElement(tag), props || {});
  for (const child of children || []) node.append(child);
  return node;
};
const byId = (id) => document.getElementById(id);
const fail = (sentence) => { byId('error').textContent = sentence; };

async function api(path, body) {
  const init = { headers: { 'x-douze-token': TOKEN } };
  if (body) {
    init.method = 'POST';
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

function editable(tag, candidate, field, className) {
  const node = el(tag, { className, textContent: candidate[field], contentEditable: 'plaintext-only' });
  node.setAttribute('aria-label', field === 'name' ? 'Short name for this skill' : 'What this skill does');
  node.addEventListener('blur', async () => {
    const value = node.textContent.trim();
    if (value === candidate[field] || value === '') { node.textContent = candidate[field]; return; }
    try {
      await api('/api/review/' + SESSION + '/edit', { name: candidate.name, field, value });
      fail('');
      await load();
    } catch (error) {
      node.textContent = candidate[field];
      fail("Couldn't save that. Nothing has changed — try again.");
    }
  });
  return node;
}

function item(candidate) {
  const consequence = el('p', {
    className: 'consequence',
    textContent: candidate.side_effect === 'destructive'
      ? 'Removes data. Asks first.'
      : 'Changes your account.',
    hidden: candidate.side_effect === 'read',
  });
  const box = el('input', { type: 'checkbox', checked: chosen.has(candidate.name) });
  box.setAttribute('aria-label', 'Use skill: ' + candidate.description);
  box.addEventListener('change', () => {
    if (box.checked) chosen.add(candidate.name); else chosen.delete(candidate.name);
    syncButton();
  });
  const seen = candidate.observations === 1 ? 'Seen once' : 'Seen ' + candidate.observations + ' times';
  // Verbatim. Rewriting it here produced "Fetches the v1." — the from/by strip ate the object of
  // the sentence — and the words shown stopped matching the words the user can edit below.
  const summary = candidate.description;
  const parts = [
    el('div', { className: 'head' }, [
      el('label', { className: 'toggle' }, [
        box,
        el('span', { className: 'sr-only', textContent: 'Use this skill' }),
      ]),
      el('div', { className: 'skill-copy' }, [
        el('p', { className: 'desc', textContent: summary }),
        consequence,
      ]),
    ]),
  ];
  const detailParts = [
    editable('p', candidate, 'description', 'full-desc'),
    el('p', { className: 'meta' }, [
      el('span', { textContent: seen }),
      editable('code', candidate, 'name', 'name'),
    ]),
  ];
  for (const [flag, sentence] of WARNINGS) {
    if (candidate.flags[flag]) detailParts.push(el('p', { className: 'warn', textContent: sentence }));
  }
  detailParts.push(
    el('p', { className: 'warn', textContent: candidate.request.method + ' ' + candidate.request.path }),
    el('pre', { textContent: JSON.stringify(candidate.sample, null, 2) }),
    el('pre', { textContent: ['Input schema', JSON.stringify(candidate.request.input_schema, null, 2)].join(String.fromCharCode(10)) }),
  );
  parts.push(
    el('details', {}, [el('summary', { textContent: 'Details' }), ...detailParts]),
  );
  return el('li', { className: 'skill' }, parts);
}

function group(kind, candidates) {
  const copy = GROUPS[kind];
  return el('section', { className: 'group ' + kind }, [
    el('div', { className: 'group-heading' }, [
      el('h2', { textContent: copy.title + ' ' }, [
        el('span', { className: 'group-count', textContent: '(' + candidates.length + ')' }),
      ]),
      el('p', { textContent: copy.detail }),
    ]),
    el('ul', {}, candidates.map(item)),
  ]);
}

function syncButton() {
  const count = chosen.size;
  const total = state.candidates.length;
  byId('count').textContent = count + ' of ' + total + ' selected';
  byId('go').disabled = count === 0;
  byId('go').textContent = count === 0
    ? 'Choose a skill'
    : 'Keep ' + count + ' skill' + (count === 1 ? '' : 's');
  byId('all').disabled = count === total;
  byId('none').disabled = count === 0;
}

function render() {
  byId('eyebrow').textContent = 'Douze · ' + state.site;
  byId('title').textContent = 'Choose what to keep';
  byId('sub').textContent = 'Everything that only reads is selected. Turn on anything that makes changes.';
  const groups = byId('groups');
  groups.textContent = '';
  for (const kind of ['read', 'write', 'destructive']) {
    const candidates = state.candidates.filter((candidate) => candidate.side_effect === kind);
    if (candidates.length > 0) groups.append(group(kind, candidates));
  }
  byId('toolbar').hidden = false;
  byId('actions').hidden = false;
  byId('after').hidden = true;
  syncButton();
}

async function load() {
  state = await api('/api/review/' + SESSION);
  const names = new Set(state.candidates.map((candidate) => candidate.name));
  for (const name of chosen) if (!names.has(name)) chosen.delete(name);
  // Seed once so an edit/reload does not undo a choice the user already made.
  //
  // Reads only. Pre-selecting everything meant one click on the primary button approved a delete
  // the user had never read — the same thing AC-REC-002.3 refuses to do through the bulk API.
  if (!seeded) {
    seeded = true;
    for (const candidate of state.candidates) if (candidate.bulk_approvable) chosen.add(candidate.name);
  }
  render();
}

function done(count) {
  byId('title').textContent = 'All set';
  byId('sub').textContent = 'Douze is ready on ' + state.site + '.';
  byId('groups').textContent = '';
  byId('toolbar').hidden = true;
  byId('actions').hidden = true;
  byId('after').hidden = false;
  byId('success-copy').textContent = count + ' skill' + (count === 1 ? '' : 's') + ' ready.';
}

byId('all').addEventListener('click', () => {
  for (const candidate of state.candidates) chosen.add(candidate.name);
  render();
});

byId('none').addEventListener('click', () => {
  chosen.clear();
  render();
});

byId('go').addEventListener('click', async () => {
  const all = state.candidates.map((candidate) => candidate.name);
  try {
    fail('');
    await api('/api/review/' + SESSION + '/enable', { names: all.filter((name) => chosen.has(name)) });
    const off = all.filter((name) => !chosen.has(name));
    if (off.length > 0) await api('/api/review/' + SESSION + '/disable', { names: off });
    const report = await api('/api/review/' + SESSION + '/save', {});
    done(report.tools.length);
  } catch (error) {
    fail("Couldn't save that. Nothing has changed — try again.");
  }
});

byId('back').addEventListener('click', () => { fail(''); render(); });

load().catch(() =>
  fail(
    "Couldn't load what this site can do. Try reloading this page. " +
      "If that doesn't help, click the Douze button in Chrome and record the site again.",
  ),
);
`

/** Keep user-controlled ids from terminating the inline script. */
const inline = (value: string): string => JSON.stringify(value).replaceAll('<', '\\u003c')

const escapeText = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
