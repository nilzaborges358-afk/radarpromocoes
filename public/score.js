// Score de venda (0-100): quanto uma promoção tem de chance de converter e de valer a divulgação.
// Roda no navegador (painel) e no servidor (Disparador) — mesma regra nos dois, para o painel e o disparo concordarem.
//
// O que um divulgador experiente olha, nesta ordem:
//   1) o desconto é REAL? (queda comprovada no histórico vale muito mais que "preço de tabela" informado pelo vendedor)
//   2) é grande o bastante para chamar atenção, mas sem cara de golpe (acima de 70% = suspeito)?
//   3) cabe no bolso de impulso? (R$ 25–200 vende no WhatsApp; abaixo de R$ 10 rende nada, acima de R$ 800 não é impulso)
//   4) quanto o cliente ECONOMIZA em reais ("economize R$ 80" pesa mais que "-12%")
//   5) outras pessoas compram e gostam? (vendas e nota, quando a loja informa)
//   6) quanto eu ganho? (comissão, quando informada)
//   7) a oferta é de agora? (vista na última busca)
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Score = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const TOP = 68;   // 🔥 Destaque
  const GOOD = 52;  // ✅ Boa
  const MAX_RAW = 110;
  const TIER_LABEL = { top: 'Destaque', good: 'Boa', common: 'Comum' };

  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

  function compute(p, nowMs) {
    const now = nowMs || Date.now();
    const price = num(p.current_price) || 0;
    const prev = num(p.previous_price);
    const disc = num(p.discount_rate) || 0;
    const source = p.source || '';
    const good = []; const bad = [];
    let raw = 0;

    // 1) Desconto (0-35) + prova (0-10)
    let dpts = disc < 10 ? 0 : disc < 20 ? 8 : disc < 30 ? 16 : disc < 45 ? 26 : 35;
    const listedOnly = source === 'shopee_listed_price';
    if (disc > 70) { raw -= 40; bad.push(`desconto de ${Math.round(disc)}% parece preço de tabela inflado`); dpts = 0; }
    else if (listedOnly) { dpts = Math.min(dpts, 14); bad.push('desconto só de preço de tabela (sem queda comprovada)'); }
    raw += dpts;
    if (dpts >= 16 && !listedOnly) good.push(`${Math.round(disc)}% de desconto`);
    if (source === 'shopee_affiliate_api') { raw += 10; good.push('queda de preço comprovada no histórico'); }
    else if (source === 'netshoes_coupon') { raw += 8; good.push('oferta com cupom'); }
    else if (source === 'catalog_search' || source === 'watchlist_check' || source === 'netshoes_rakuten_api') { raw += 6; }

    // 2) Faixa de preço de impulso (0-15)
    let ppts = 0;
    if (price >= 25 && price <= 200) { ppts = 15; good.push('faixa de preço que vende fácil'); }
    else if ((price >= 15 && price < 25) || (price > 200 && price <= 400)) ppts = 10;
    else if ((price >= 10 && price < 15) || (price > 400 && price <= 800)) ppts = 5;
    else if (price > 0) { if (price < 10) raw -= 10; bad.push(price < 10 ? 'preço muito baixo (comissão irrisória)' : 'preço alto (compra de impulso é rara)'); }
    raw += ppts;

    // 3) Economia em reais (0-10)
    const saved = prev && prev > price ? prev - price : 0;
    const spts = saved >= 100 ? 10 : saved >= 50 ? 8 : saved >= 25 ? 6 : saved >= 10 ? 3 : 0;
    raw += spts;
    if (spts >= 8) good.push(`economia de R$ ${Math.round(saved)}`);

    // 4) Prova social (0-20): vendas + nota; sem informação = neutro
    const sales = num(p.sales); const rating = num(p.rating);
    let sp = 0;
    if (sales === null && rating === null) sp = 6;
    else {
      if (sales !== null) { sp += sales >= 1000 ? 12 : sales >= 300 ? 9 : sales >= 50 ? 5 : 1; if (sales >= 300) good.push(`${sales >= 1000 ? Math.floor(sales / 100) / 10 + ' mil' : sales} vendidos`); }
      if (rating !== null) { sp += rating >= 4.7 ? 8 : rating >= 4.5 ? 6 : rating >= 4.2 ? 3 : rating >= 4 ? 0 : -8; if (rating >= 4.7) good.push(`nota ${rating.toFixed(1)}`); if (rating < 4) bad.push(`nota baixa (${rating.toFixed(1)})`); }
    }
    raw += sp;

    // 5) Comissão (0-10)
    let c = num(p.commission_rate);
    if (c !== null && c <= 1) c *= 100; // veio como fração (0.1 = 10%)
    const cpts = c === null ? 4 : c >= 12 ? 10 : c >= 8 ? 7 : c >= 5 ? 4 : 2;
    raw += cpts;
    if (c !== null && c >= 8) good.push(`comissão de ${Math.round(c)}%`);

    // 6) Frescor (0-10): visto na última busca
    const seen = new Date(p.last_seen_at || p.detected_at || 0).getTime();
    const hours = seen ? (now - seen) / 36e5 : 999;
    raw += hours <= 6 ? 10 : hours <= 24 ? 6 : hours <= 48 ? 2 : 0;
    if (hours > 48) bad.push('não é vista há mais de 2 dias');

    const score = Math.max(0, Math.min(100, Math.round((raw * 100) / MAX_RAW)));
    return { score, tier: score >= TOP ? 'top' : score >= GOOD ? 'good' : 'common', good, bad };
  }

  return { compute, TOP, GOOD, TIER_LABEL };
});
