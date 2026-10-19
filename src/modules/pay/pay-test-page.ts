/** Fixed dram rate for test keys. The live checkout uses the provider's own rate instead. */
export const TEST_AMD_PER_UNIT = 400;

export function testAmdQuote(amountMinor: number): { amountAmd: number; exchangeRate: number } {
  const amountAmd = Number(((amountMinor / 100) * TEST_AMD_PER_UNIT).toFixed(2));
  return { amountAmd, exchangeRate: TEST_AMD_PER_UNIT };
}

export function testCardPage(input: {
  productName: string;
  amount: number;
  currency: string;
  amountAmd: number;
  exchangeRate: number;
  action: string;
  cancelUrl: string;
}): string {
  const amount = money(input.amount, input.currency);
  const amd = money(input.amountAmd, 'AMD');
  return layout(
    input.productName,
    `<p class="product">${esc(input.productName)}</p>
     <p class="amount">${esc(amount)}</p>
     <p class="amd">${esc(amd)}, soit 1 ${esc(input.currency)} = ${esc(money(input.exchangeRate, 'AMD'))}</p>
     <form method="post" action="${esc(input.action)}">
       <label>Numéro de carte<input inputmode="numeric" autocomplete="cc-number" maxlength="23" required></label>
       <div class="row">
         <label>Expiration<input autocomplete="cc-exp" placeholder="MM/AA" maxlength="7" required></label>
         <label>Cryptogramme<input inputmode="numeric" autocomplete="cc-csc" maxlength="4" required></label>
       </div>
       <label>Nom sur la carte<input autocomplete="cc-name" maxlength="80" required></label>
       <button type="submit">Payer ${esc(amount)}</button>
     </form>
     <a class="cancel" href="${esc(input.cancelUrl)}">Annuler</a>
     <p class="note">Paiement test. Aucune carte n’est débitée.</p>`,
  );
}

export function testClosedPage(): string {
  return layout('Paiement test', '<p class="amount">Ce paiement test n’est plus ouvert.</p>');
}

export function testMissingPage(): string {
  return layout('Paiement test', '<p class="amount">Ce lien de paiement est inconnu.</p>');
}

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${esc(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px 16px;
      background: #d7e0e4;
      color: #14242c;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
    }
    main {
      width: min(100%, 24rem);
      padding: 28px 24px 22px;
      background: #f4f7f8;
      border-radius: 18px 18px 14px 14px;
      box-shadow: 0 18px 40px rgba(20, 36, 44, 0.16);
    }
    .mark { margin: 0 0 18px; font-size: 0.95rem; }
    .product { margin: 0; color: #5c6e78; }
    .amount {
      margin: 8px 0 0;
      font-family: "Iowan Old Style", Palatino, "Palatino Linotype", serif;
      font-size: 2.6rem;
      line-height: 1;
      font-weight: 600;
    }
    .amd { margin: 10px 0 22px; color: #3e555f; }
    label { display: block; margin: 0 0 12px; font-size: 0.92rem; }
    input {
      display: block;
      width: 100%;
      margin-top: 6px;
      padding: 12px 12px;
      border: 1px solid #c5d0d6;
      border-radius: 10px;
      background: white;
      color: inherit;
      font: inherit;
      font-size: 16px;
    }
    input:focus { outline: 2px solid #0e6b66; outline-offset: 1px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    button {
      width: 100%;
      margin-top: 6px;
      padding: 14px 16px;
      border: 0;
      border-radius: 12px;
      background: #0e6b66;
      color: white;
      font: inherit;
      font-size: 1rem;
      cursor: pointer;
    }
    button:focus-visible { outline: 2px solid #14242c; outline-offset: 2px; }
    .cancel { display: inline-block; margin-top: 14px; color: #3e555f; }
    .note { margin: 16px 0 0; color: #5c6e78; font-size: 0.9rem; }
  </style>
</head>
<body>
  <main>
    <p class="mark">Paiement test</p>
    ${body}
  </main>
</body>
</html>`;
}

function money(amount: number, currency: string): string {
  const formatted = amount.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${formatted} ${currency}`;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, char =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '"' ? '&quot;' : '&#39;',
  );
}
