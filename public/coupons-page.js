// =====================================================================
// Cupons do produto + Meus cupons
// =====================================================================
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str == null ? '' : String(str);
  return d.innerHTML;
}
const brl = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function couponApi(body) {
  const res = await fetch('/api/quicklink', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Falha na requisição');
  return data;
}

function verifiedBadge(c) {
  if (!c.last_verified_at) return '<span class="cp-badge warn">nunca confirmado por você</span>';
  const days = Math.floor((Date.now() - new Date(c.last_verified_at).getTime()) / 864e5);
  if (days <= 0) return '<span class="cp-badge ok">confirmado hoje</span>';
  return `<span class="cp-badge ${days <= 3 ? 'ok' : 'warn'}">confirmado há ${days} dia(s)</span>`;
}

function couponDesc(c) {
  const val = c.discount_type === 'percent' ? `${Number(c.discount_value)}% OFF` : `R$ ${brl(c.discount_value)} OFF`;
  const parts = [val];
  if (c.max_discount) parts.push(`teto R$ ${brl(c.max_discount)}`);
  if (c.min_purchase) parts.push(`compra mín. R$ ${brl(c.min_purchase)}`);
  if (c.valid_until) parts.push(`até ${String(c.valid_until).slice(8, 10)}/${String(c.valid_until).slice(5, 7)}`);
  if (c.notes) parts.push(c.notes);
  return parts.join(' · ');
}

async function checkCoupons() {
  const url = document.getElementById('cp-url').value.trim();
  const price = document.getElementById('cp-price').value.trim();
  const btn = document.getElementById('cp-btn');
  const msg = document.getElementById('cp-msg');
  const box = document.getElementById('cp-result');
  if (!url) { msg.textContent = 'Cole o link do produto primeiro.'; msg.className = 'msg error'; return; }

  btn.disabled = true; btn.textContent = 'Analisando...';
  msg.textContent = ''; msg.className = 'msg'; box.innerHTML = '';

  try {
    const r = await couponApi({ action: 'coupons_check', url, price });
    if (r.marketplace === 'netshoes') { renderNetshoesCheck(r, box); return; }
    let html = '';

    if (r.product && r.product.source === 'page') {
      html += `<div class="cp-note" style="color:var(--accent)">A API do Mercado Livre bloqueou esse produto, então li os dados pela página pública. Preço, título e imagem costumam vir certos; categoria e vendedor podem não vir — nesse caso os cupons restritos aparecem com um aviso "confira".</div>`;
    }
    if (r.product) {
      const p = r.product;
      html += `<div class="cp-product">
        ${p.thumbnail ? `<img src="${esc(p.thumbnail)}" alt="" />` : ''}
        <div>
          <div class="t">${esc(p.title)}</div>
          <div class="m">R$ ${brl(r.priceUsed)}${p.originalPrice ? ` <s>R$ ${brl(p.originalPrice)}</s>` : ''}${p.promotionType ? ` · promoção do ML: ${esc(p.promotionType)}` : ''} · <a href="${esc(p.permalink)}" target="_blank" rel="noopener" style="color:var(--accent)">abrir produto ↗</a></div>
        </div>
      </div>`;
    } else if (r.productError) {
      html += `<div class="cp-note" style="color:var(--accent)"><b>O Mercado Livre bloqueia a leitura automática desse produto.</b> Digite o preço do produto no campo ao lado e clique em "Ver cupons" de novo para eu calcular o valor final com cada cupom.
        <details class="cp-excluded"><summary>detalhes técnicos</summary><div style="margin-top:6px; word-break:break-all;">${esc(r.productError)}</div></details></div>`;
    } else if (!r.marketplace) {
      html += `<div class="cp-note">Não reconheci o marketplace desse link; mostrei os cupons do Mercado Livre. Preencha o preço para calcular o valor final.</div>`;
    } else if (r.marketplace !== 'mercadolivre') {
      html += `<div class="cp-note">Para ${esc(r.marketplace)} não tenho uma fonte automática de cupons nem leio os dados do produto: abaixo aparecem só os cupons que você cadastrou, e o preço você digita no campo ao lado.</div>`;
    }

    if (!r.totalCoupons) {
      html += `<div class="cp-note">Você ainda não cadastrou nenhum cupom. Use o bloco "Cupons que posso divulgar" logo abaixo.</div>`;
    } else if (!r.applicable.length) {
      html += `<div class="cp-note"><b>Nenhum dos seus cupons vale para esse produto.</b> Veja abaixo o motivo de cada um.</div>`;
    } else {
      html += `<div class="cp-list">` + r.applicable.map((a, i) => {
        const c = a.coupon;
        return `<div class="cp-item ${i === 0 ? 'best' : ''}">
          <div>
            <div class="cp-name">${i === 0 ? '⭐ ' : ''}${esc(c.title)} ${c.code ? `<span class="cp-code">${esc(c.code)}</span>` : '<span class="cp-badge">automático</span>'}</div>
            <div class="cp-meta">${esc(couponDesc(c))}${a.warnings.length ? `<br><span style="color:var(--accent)">${esc(a.warnings.join(' · '))}</span>` : ''}</div>
            <div class="cp-meta">${verifiedBadge(c)}</div>
          </div>
          <div class="cp-actions">
            ${a.finalPrice != null ? `<div><div class="cp-final">R$ ${brl(a.finalPrice)}</div><div class="cp-meta">economiza R$ ${brl(a.discount)}</div></div>` : ''}
            ${c.code ? `<button data-copy-code="${esc(c.code)}">Copiar código</button>` : ''}
            <button data-verify="${c.id}">Confirmei hoje</button>
          </div>
        </div>`;
      }).join('') + `</div>`;
      html += `<div class="cp-note">Regra comum do Mercado Livre: vale 1 cupom por produto, normalmente o de maior desconto (o ⭐). Cupons que aparecem só na página do produto (do vendedor ou da campanha) não têm API pública — confira também lá antes de passar para o cliente.</div>`;
    }

    if (r.excluded && r.excluded.length) {
      html += `<details class="cp-excluded"><summary>${r.excluded.length} cupom(ns) que NÃO valem para esse produto</summary>` +
        r.excluded.map((e) => `<div style="margin-top:6px"><b>${esc(e.coupon.title)}</b>: ${esc(e.reasons.join('; '))}</div>`).join('') + `</details>`;
    }

    box.innerHTML = html;
    box.querySelectorAll('[data-copy-code]').forEach((b) => b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(b.dataset.copyCode);
      const t = b.textContent; b.textContent = 'Copiado!'; setTimeout(() => { b.textContent = t; }, 1500);
    }));
    box.querySelectorAll('[data-verify]').forEach((b) => b.addEventListener('click', async () => {
      await couponApi({ action: 'coupons_verify', id: b.dataset.verify });
      b.textContent = 'Confirmado ✓';
      loadCoupons();
    }));
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`; msg.className = 'msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Ver cupons';
  }
}

let allCoupons = [];
let editingId = null;

async function loadCoupons() {
  const list = document.getElementById('cp-all');
  try {
    const data = await couponApi({ action: 'coupons_list' });
    allCoupons = data.coupons || [];
    if (!allCoupons.length) {
      list.innerHTML = '<div class="cp-item"><span class="cp-meta">Nenhum cupom cadastrado ainda.</span></div>';
      return;
    }
    list.innerHTML = allCoupons.map((c) => `
      <div class="cp-item" style="${c.active ? '' : 'opacity:.55'}">
        <div>
          <div class="cp-name">${esc(c.title)} ${c.code ? `<span class="cp-code">${esc(c.code)}</span>` : '<span class="cp-badge">automático</span>'}</div>
          <div class="cp-meta">${esc(couponDesc(c))}${c.category_ids ? ` · categorias: ${esc(c.category_ids)}` : ''}${c.seller_ids ? ` · vendedores: ${esc(c.seller_ids)}` : ''}</div>
          <div class="cp-meta">${verifiedBadge(c)}${c.active ? '' : ' <span class="cp-badge">desativado</span>'}</div>
        </div>
        <div class="cp-actions">
          <button data-v="${c.id}">Confirmei hoje</button>
          <button data-e="${c.id}">Editar</button>
          <button data-t="${c.id}">${c.active ? 'Desativar' : 'Ativar'}</button>
          <button class="danger" data-d="${c.id}">Remover</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', async () => { await couponApi({ action: 'coupons_verify', id: b.dataset.v }); loadCoupons(); }));
    list.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', async () => {
      const c = allCoupons.find((x) => x.id === b.dataset.t);
      await couponApi({ action: 'coupons_toggle', id: c.id, active: !c.active }); loadCoupons();
    }));
    list.querySelectorAll('[data-d]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Remover esse cupom?')) return;
      await couponApi({ action: 'coupons_delete', id: b.dataset.d }); loadCoupons();
    }));
    list.querySelectorAll('[data-e]').forEach((b) => b.addEventListener('click', () => startEdit(b.dataset.e)));
  } catch (err) {
    list.innerHTML = `<div class="cp-item"><span class="cp-meta" style="color:var(--bad)">Erro ao carregar cupons: ${esc(err.message)}</span></div>`;
  }
}

const F = (id) => document.getElementById(id);

function startEdit(id) {
  const c = allCoupons.find((x) => x.id === id);
  if (!c) return;
  editingId = id;
  F('f-title').value = c.title || ''; F('f-code').value = c.code || '';
  F('f-type').value = c.discount_type; F('f-value').value = c.discount_value;
  F('f-max').value = c.max_discount ?? ''; F('f-min').value = c.min_purchase ?? '';
  F('f-until').value = c.valid_until ? String(c.valid_until).slice(0, 10) : '';
  F('f-cats').value = c.category_ids || ''; F('f-sellers').value = c.seller_ids || '';
  F('f-notes').value = c.notes || '';
  F('f-save').textContent = 'Atualizar cupom'; F('f-cancel').style.display = '';
  F('cp-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function resetForm() {
  editingId = null;
  ['f-title', 'f-code', 'f-value', 'f-max', 'f-min', 'f-until', 'f-cats', 'f-sellers', 'f-notes'].forEach((id) => { F(id).value = ''; });
  F('f-type').value = 'percent';
  F('f-save').textContent = 'Salvar cupom'; F('f-cancel').style.display = 'none';
}

async function saveCoupon() {
  const msg = F('f-msg');
  F('f-save').disabled = true; msg.textContent = ''; msg.className = 'msg';
  try {
    await couponApi({
      action: 'coupons_save', id: editingId, marketplace_slug: 'mercadolivre',
      title: F('f-title').value, code: F('f-code').value, discount_type: F('f-type').value,
      discount_value: F('f-value').value, max_discount: F('f-max').value, min_purchase: F('f-min').value,
      valid_until: F('f-until').value, category_ids: F('f-cats').value, seller_ids: F('f-sellers').value, notes: F('f-notes').value,
    });
    msg.textContent = editingId ? 'Cupom atualizado.' : 'Cupom salvo.';
    resetForm();
    await loadCoupons();
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`; msg.className = 'msg error';
  } finally {
    F('f-save').disabled = false;
  }
}

F('cp-btn').addEventListener('click', checkCoupons);
F('cp-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkCoupons(); });
F('f-save').addEventListener('click', saveCoupon);
F('f-cancel').addEventListener('click', resetForm);
loadCoupons();

// =====================================================================
// Cupons da Netshoes (Rakuten) + produtos com o cupom aplicado
// =====================================================================
let nsCoupons = [];

function nsDate(d) {
  const day = String(d || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : null;
}

function nsParsedLabel(c) {
  const p = c.parsed || {};
  if (!p.type || !p.value) return '';
  const val = p.type === 'percent' ? `${p.value}% OFF` : `R$ ${brl(p.value)} OFF`;
  return `lido do texto: ${p.approx ? 'até ' : ''}${val}${p.min ? ` · compra mín. R$ ${brl(p.min)}` : ''}`;
}

function nsCouponMessage(c) {
  const until = nsDate(c.endsAt);
  return [
    '🏷️ CUPOM NETSHOES',
    c.description || '',
    c.code ? `✅ Código: ${c.code}` : '',
    c.restriction ? `⚠️ ${c.restriction}` : '',
    until ? `⏰ Válido até ${until}` : '',
    c.clickUrl ? `👉 ${c.clickUrl}` : '',
  ].filter(Boolean).join('\n');
}

function nsProductMessage(p, c) {
  const price = p.finalPrice != null ? p.finalPrice : p.price;
  return [
    `🔥 ${p.title}`,
    p.regularPrice ? `De R$ ${brl(p.regularPrice)} por R$ ${brl(p.price)}` : `R$ ${brl(p.price)}`,
    p.finalPrice != null && c.code ? `🏷️ Com o cupom ${c.code}: R$ ${brl(price)}` : (c.code ? `🏷️ Cupom: ${c.code}` : ''),
    `👉 ${p.affiliateUrl}`,
  ].filter(Boolean).join('\n');
}

async function nsCopy(btn, text) {
  await navigator.clipboard.writeText(text);
  const t = btn.textContent; btn.textContent = 'Copiado!'; setTimeout(() => { btn.textContent = t; }, 1500);
}

function nsRender(r) {
  const box = F('ns-result');
  nsCoupons = r.coupons || [];
  let html = '';
  if (!nsCoupons.length) {
    html += `<div class="cp-note"><b>A Rakuten não devolveu nenhum cupom ativo para a Netshoes.</b> ${r.expired ? `(${r.expired} já vencido(s) foram ignorados.) ` : ''}Pode ser que a Netshoes não tenha cupom para afiliados agora, ou que sua conta ainda não tenha acesso a esse serviço.${r.rawSample ? `<details class="cp-excluded"><summary>resposta recebida da Rakuten</summary><div style="margin-top:6px; word-break:break-all;">${esc(r.rawSample)}</div></details>` : ''}</div>`;
    box.innerHTML = html;
    return;
  }
  html += `<div class="cp-note" style="margin-top:4px;">${r.total} cupom(ns)/oferta(s) ativo(s), ${r.withCode} com código.${r.expired ? ` ${r.expired} vencido(s) ocultado(s).` : ''}</div>`;
  html += `<div class="cp-list">` + nsCoupons.map((c, i) => {
    const until = nsDate(c.endsAt);
    const parsed = nsParsedLabel(c);
    return `<div class="cp-item" data-i="${i}" style="flex-direction:column; align-items:stretch;">
      <div style="display:flex; gap:12px; align-items:center; justify-content:space-between; flex-wrap:wrap;">
        <div style="flex:1; min-width:220px;">
          <div class="cp-name">${esc(c.description || '(sem descrição)')} ${c.code ? `<span class="cp-code">${esc(c.code)}</span>` : '<span class="cp-badge">sem código (oferta)</span>'}</div>
          <div class="cp-meta">${until ? `válido até ${until}` : 'sem data de validade informada'}${parsed ? ` · <span style="color:var(--accent)">${esc(parsed)}</span>` : ''}${c.categories && c.categories.length ? ` · ${esc(c.categories.slice(0, 3).join(', '))}` : ''}</div>
          ${c.restriction ? `<div class="cp-meta"><b>Restrição:</b> ${esc(c.restriction)}</div>` : ''}
        </div>
        <div class="cp-actions">
          ${c.code ? `<button data-ns-code="${i}">Copiar código</button>` : ''}
          <button data-ns-msg="${i}">Copiar mensagem</button>
          <button data-ns-wa="${i}">WhatsApp</button>
          <button data-ns-products="${i}">Ver produtos</button>
        </div>
      </div>
      <div class="ns-products" id="ns-p-${i}" style="display:none; margin-top:12px;"></div>
    </div>`;
  }).join('') + `</div>`;
  box.innerHTML = html;
}

function nsOpenProducts(i) {
  const c = nsCoupons[i];
  const panel = F(`ns-p-${i}`);
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }
  const guess = (c.categories && c.categories[0]) || '';
  panel.style.display = '';
  panel.innerHTML = `<div class="row">
      <input type="text" id="ns-kw-${i}" value="${esc(guess)}" placeholder="O que buscar? (ex: tênis corrida, camisa nike)" />
      <button data-ns-search="${i}">Buscar produtos</button>
    </div>
    <div class="cp-note" style="margin-top:6px;">Os produtos vêm da busca da Netshoes por palavra-chave. A Rakuten <b>não diz</b> em quais produtos o cupom vale: confira a restrição acima (marcas, categorias, exceções) antes de divulgar.</div>
    <div class="msg" id="ns-pm-${i}"></div>
    <div id="ns-pr-${i}"></div>`;
  F(`ns-kw-${i}`).addEventListener('keydown', (e) => { if (e.key === 'Enter') nsSearchProducts(i); });
}

async function nsSearchProducts(i) {
  const c = nsCoupons[i];
  const kw = F(`ns-kw-${i}`).value.trim();
  const msg = F(`ns-pm-${i}`);
  const out = F(`ns-pr-${i}`);
  if (!kw) { msg.textContent = 'Digite o que buscar.'; msg.className = 'msg error'; return; }
  msg.textContent = 'Buscando...'; msg.className = 'msg'; out.innerHTML = '';
  try {
    const p = c.parsed || {};
    const r = await couponApi({
      action: 'coupons_netshoes_products', keyword: kw,
      discount_type: p.type, discount_value: p.value, min_purchase: p.min,
    });
    msg.textContent = r.total ? `${r.total} produto(s).` : 'Nenhum produto encontrado para essa busca.';
    out.innerHTML = `<div class="cp-list">` + r.products.map((x, k) => `
      <div class="cp-item">
        <div style="display:flex; gap:12px; align-items:center; flex:1; min-width:220px;">
          ${x.imageUrl ? `<img src="${esc(x.imageUrl)}" alt="" style="width:56px; height:56px; object-fit:contain; background:#fff;" />` : ''}
          <div>
            <div class="cp-name">${esc(x.title)}</div>
            <div class="cp-meta">R$ ${brl(x.price)}${x.regularPrice ? ` <s>R$ ${brl(x.regularPrice)}</s>` : ''}${x.note ? ` · <span style="color:var(--accent)">${esc(x.note)}</span>` : ''}${x.applies === null ? ' · não consegui ler o valor do desconto: calcule com a restrição' : ''}</div>
          </div>
        </div>
        <div class="cp-actions">
          ${x.finalPrice != null ? `<div><div class="cp-final">R$ ${brl(x.finalPrice)}</div><div class="cp-meta">com o cupom</div></div>` : ''}
          <button data-ns-pmsg="${i}:${k}">Copiar mensagem</button>
          <button data-ns-pwa="${i}:${k}">WhatsApp</button>
        </div>
      </div>`).join('') + `</div>`;
    out._products = r.products;
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`; msg.className = 'msg error';
  }
}

async function nsFetch() {
  const btn = F('ns-btn'); const msg = F('ns-msg');
  btn.disabled = true; btn.textContent = 'Buscando...';
  msg.textContent = ''; msg.className = 'msg'; F('ns-result').innerHTML = '';
  try {
    nsRender(await couponApi({ action: 'coupons_netshoes_fetch' }));
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`; msg.className = 'msg error';
  } finally {
    btn.disabled = false; btn.textContent = 'Buscar cupons da Netshoes';
  }
}

F('ns-btn').addEventListener('click', nsFetch);
F('ns-result').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.nsCode !== undefined) nsCopy(b, nsCoupons[d.nsCode].code);
  else if (d.nsMsg !== undefined) nsCopy(b, nsCouponMessage(nsCoupons[d.nsMsg]));
  else if (d.nsWa !== undefined) window.open(`https://wa.me/?text=${encodeURIComponent(nsCouponMessage(nsCoupons[d.nsWa]))}`, '_blank');
  else if (d.nsProducts !== undefined) nsOpenProducts(d.nsProducts);
  else if (d.nsSearch !== undefined) nsSearchProducts(d.nsSearch);
  else if (d.nsPmsg !== undefined || d.nsPwa !== undefined) {
    const [i, k] = String(d.nsPmsg !== undefined ? d.nsPmsg : d.nsPwa).split(':');
    const prod = F(`ns-pr-${i}`)._products[Number(k)];
    const text = nsProductMessage(prod, nsCoupons[i]);
    if (d.nsPmsg !== undefined) nsCopy(b, text);
    else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
  }
});

// ---------- Resultado da checagem de produto da Netshoes ----------
let nsCheck = null;

function nsCheckMessage(r, item) {
  const p = r.product;
  const c = item.coupon;
  return [
    `🔥 ${p.title}`,
    p.price ? (p.regularPrice ? `De R$ ${brl(p.regularPrice)} por R$ ${brl(p.price)}` : `R$ ${brl(p.price)}`) : '',
    c.code ? (item.finalPrice != null ? `🏷️ Com o cupom ${c.code}: R$ ${brl(item.finalPrice)}` : `🏷️ Cupom: ${c.code}`) : `🏷️ ${c.description || 'Oferta ativa'}`,
    c.restriction ? `⚠️ ${c.restriction}` : '',
    nsDate(c.endsAt) ? `⏰ Válido até ${nsDate(c.endsAt)}` : '',
    `👉 ${r.affiliateUrl}`,
  ].filter(Boolean).join('\n');
}

function nsCheckItemHtml(item, group, idx) {
  const c = item.coupon;
  const parsed = nsParsedLabel(c);
  const until = nsDate(c.endsAt);
  const best = group === 'ok' && idx === 0;
  return `<div class="cp-item ${best ? 'best' : ''}">
    <div style="flex:1; min-width:220px;">
      <div class="cp-name">${best ? '⭐ ' : ''}${esc(c.description || '(sem descrição)')} ${c.code ? `<span class="cp-code">${esc(c.code)}</span>` : '<span class="cp-badge">sem código (oferta)</span>'}</div>
      <div class="cp-meta">${until ? `válido até ${until}` : 'sem data de validade informada'}${parsed ? ` · <span style="color:var(--accent)">${esc(parsed)}</span>` : ''}</div>
      ${c.restriction ? `<div class="cp-meta"><b>Restrição:</b> ${esc(c.restriction)}</div>` : '<div class="cp-meta">Sem restrição informada pela Rakuten.</div>'}
      ${item.notes.length ? `<div class="cp-meta">${esc(item.notes.join(' · '))}</div>` : ''}
      ${item.warnings.length ? `<div class="cp-meta" style="color:var(--accent)">${esc(item.warnings.join(' · '))}</div>` : ''}
    </div>
    <div class="cp-actions">
      ${item.finalPrice != null ? `<div><div class="cp-final">R$ ${brl(item.finalPrice)}</div><div class="cp-meta">economiza R$ ${brl(item.discount)}</div></div>` : ''}
      ${c.code ? `<button data-nsc-code="${group}:${idx}">Copiar código</button>` : ''}
      <button data-nsc-msg="${group}:${idx}">Copiar mensagem</button>
      <button data-nsc-wa="${group}:${idx}">WhatsApp</button>
    </div>
  </div>`;
}

function renderNetshoesCheck(r, box) {
  nsCheck = r;
  const p = r.product;
  const res = r.results;
  let html = '';

  html += `<div class="cp-product">
    ${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" />` : ''}
    <div>
      <div class="t">${esc(p.title || 'Produto da Netshoes')}</div>
      <div class="m">${p.price ? `R$ ${brl(p.price)}${p.regularPrice ? ` <s>R$ ${brl(p.regularPrice)}</s>` : ''}` : 'preço não lido'}${p.category ? ` · ${esc(p.category)}` : ''} · <a href="${esc(p.url)}" target="_blank" rel="noopener" style="color:var(--accent)">abrir produto ↗</a></div>
    </div>
  </div>`;
  if (!p.found) {
    html += `<div class="cp-note" style="color:var(--accent)"><b>Não achei esse produto na integração da Rakuten</b>, então usei só o nome que está no link${p.price ? ' e o preço que você digitou' : ''}. ${p.price ? '' : 'Digite o preço no campo ao lado e clique em "Ver cupons" de novo para calcular o valor final e checar compra mínima.'}${r.productError ? `<details class="cp-excluded"><summary>detalhes técnicos</summary><div style="margin-top:6px; word-break:break-all;">${esc(r.productError)}</div></details>` : ''}</div>`;
  }

  if (r.couponsError) {
    html += `<div class="cp-note" style="color:var(--bad)"><b>Não consegui buscar os cupons agora.</b> ${esc(r.couponsError)}</div>`;
    box.innerHTML = html;
    return;
  }

  if (res.ok.length) {
    html += `<div class="cp-note" style="margin-top:14px; color:var(--good); font-size:13px;"><b>✅ Para esse produto, use ${res.ok[0].coupon.code ? `o cupom ${esc(res.ok[0].coupon.code)}` : 'a oferta abaixo'}.</b></div>`;
    html += `<div class="cp-list">${res.ok.map((x, i) => nsCheckItemHtml(x, 'ok', i)).join('')}</div>`;
  }
  if (res.check.length) {
    html += `<div class="cp-note" style="margin-top:14px; color:var(--accent); font-size:13px;"><b>⚠️ ${res.ok.length ? 'Também podem valer' : 'Nenhum cupom confirmado, mas estes podem valer'} — confira a restrição:</b></div>`;
    html += `<div class="cp-list">${res.check.map((x, i) => nsCheckItemHtml(x, 'check', i)).join('')}</div>`;
  }
  if (!res.ok.length && !res.check.length) {
    html += `<div class="cp-note" style="margin-top:14px; color:var(--bad); font-size:13px;"><b>❌ Para esse produto não temos cupons disponíveis.</b> ${r.totalCoupons ? `Olhei ${r.totalCoupons} cupom(ns)/oferta(s) ativo(s) da Netshoes e nenhum serve.` : 'A Rakuten não devolveu nenhum cupom ativo agora.'}</div>`;
    if (!r.totalCoupons && r.rawSample) html += `<details class="cp-excluded"><summary>resposta recebida da Rakuten</summary><div style="margin-top:6px; word-break:break-all;">${esc(r.rawSample)}</div></details>`;
  }
  if (res.no.length) {
    html += `<details class="cp-excluded"><summary>${res.no.length} cupom(ns) que NÃO valem para esse produto</summary>` +
      res.no.map((x) => `<div style="margin-top:6px"><b>${esc(x.coupon.description || x.coupon.code || 'cupom')}</b>${x.coupon.code ? ` (${esc(x.coupon.code)})` : ''}: ${esc(x.reasons.join('; '))}</div>`).join('') + `</details>`;
  }
  html += `<div class="cp-note">"Vale" quer dizer que não encontrei conflito na restrição escrita pela Rakuten (compra mínima, "exceto marca X", "só para categoria Y"). A Rakuten não informa produto por produto, então vale testar o cupom no carrinho antes de divulgar em massa.</div>`;
  box.innerHTML = html;
}

F('cp-result').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !nsCheck) return;
  const d = b.dataset;
  const key = d.nscCode ?? d.nscMsg ?? d.nscWa;
  if (key === undefined) return;
  const [group, idx] = String(key).split(':');
  const item = nsCheck.results[group][Number(idx)];
  if (d.nscCode !== undefined) nsCopy(b, item.coupon.code);
  else if (d.nscMsg !== undefined) nsCopy(b, nsCheckMessage(nsCheck, item));
  else window.open(`https://wa.me/?text=${encodeURIComponent(nsCheckMessage(nsCheck, item))}`, '_blank');
});
