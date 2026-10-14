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
