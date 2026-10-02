// Roda em toda requisição (páginas e APIs), ANTES de qualquer arquivo ser
// entregue. Bloqueia tudo que não tiver o cookie de sessão válido — exceto
// a própria tela de login e o webhook do Mercado Livre (que é chamado pelo
// servidor do ML, não pelo seu navegador, então não tem como carregar cookie).
//
// A senha (PANEL_PASSWORD) e a chave de assinatura (SESSION_SECRET) ficam
// SÓ nas Environment Variables da Vercel — nunca aparecem neste arquivo
// nem em nenhum outro lugar do código.

const PUBLIC_PATHS = ['/login.html', '/api/auth/login', '/api/auth/logout', '/api/webhooks/mercadolivre'];

export const config = {
  matcher: '/:path*',
};

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function isValidSession(token, secret) {
  if (!token || !secret) return false;
  const [payload, sigHex] = token.split('.');
  if (!payload || !sigHex) return false;

  const exp = Number(payload);
  if (!exp || Math.floor(Date.now() / 1000) > exp) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const sigBytes = new Uint8Array(sigHex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
    return await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

export default async function middleware(request) {
  const url = new URL(request.url);

  if (PUBLIC_PATHS.includes(url.pathname)) {
    return; // deixa passar sem checar
  }

  const token = getCookie(request, 'radar_session');
  const valid = await isValidSession(token, process.env.SESSION_SECRET);

  if (valid) {
    return; // sessão ok, segue o fluxo normal
  }

  if (url.pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'Não autenticado.' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  url.pathname = '/login.html';
  return Response.redirect(url);
}
