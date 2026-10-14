async function generateLink(slug) {
  const urlInput = document.getElementById(`${slug}-url`);
  const btn = document.getElementById(`${slug}-btn`);
  const msg = document.getElementById(`${slug}-msg`);
  const resultBox = document.getElementById(`${slug}-result`);
  const linkText = document.getElementById(`${slug}-link-text`);

  const url = urlInput.value.trim();
  if (!url) { msg.textContent = 'Cole um link primeiro.'; msg.className = 'msg error'; return; }

  btn.disabled = true;
  btn.textContent = 'Gerando...';
  msg.textContent = '';
  msg.className = 'msg';
  resultBox.classList.remove('show');

  try {
    const res = await fetch('/api/quicklink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace: slug, url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Falha ao gerar o link');

    linkText.textContent = data.affiliateUrl;
    linkText.dataset.link = data.affiliateUrl;
    resultBox.classList.add('show');
  } catch (err) {
    msg.textContent = `Erro: ${err.message}`;
    msg.className = 'msg error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Gerar link';
  }
}

document.getElementById('shopee-btn').addEventListener('click', () => generateLink('shopee'));
document.getElementById('netshoes-btn').addEventListener('click', () => generateLink('netshoes'));

document.getElementById('ml-copy-btn').addEventListener('click', async () => {
  const url = document.getElementById('ml-url').value.trim();
  const msg = document.getElementById('ml-msg');
  if (!url) { msg.textContent = 'Cole um link primeiro.'; return; }
  await navigator.clipboard.writeText(url);
  msg.textContent = 'Copiado — agora cole na Central de Afiliados do Mercado Livre.';
});

document.querySelectorAll('[data-copy-target]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const span = document.getElementById(btn.dataset.copyTarget);
    await navigator.clipboard.writeText(span.dataset.link || span.textContent);
    const original = btn.textContent;
    btn.textContent = 'Copiado!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  });
});

document.querySelectorAll('[data-share-wa]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const slug = btn.dataset.shareWa;
    const link = document.getElementById(`${slug}-link-text`).dataset.link;
    const message = `🔥 Olha esse link:\n\n👉 ${link}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, '_blank');
  });
});

document.querySelectorAll('[data-share-tg]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const slug = btn.dataset.shareTg;
    const link = document.getElementById(`${slug}-link-text`).dataset.link;
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🔥 Olha esse link:')}`, '_blank');
  });
});


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
      html += `<div class="cp-note">Para ${esc(r.marketplace)} eu não leio os dados do produto: informe o preço no campo ao lado para calcular o valor final.</div>`;
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
