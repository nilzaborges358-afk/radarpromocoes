// Roda em toda requisição (páginas e APIs), ANTES de qualquer arquivo ser
// entregue. Bloqueia tudo que não tiver o cookie de sessão válido — exceto:
// - a própria tela de login
// - login/logout do painel
// - o webhook do Mercado Livre (chamado pelo servidor do ML, sem cookie)
// - o CALLBACK do OAuth do Mercado Livre (também chamado pelo navegador vindo
//   de outro domínio — auth.mercadolivre.com.br — então o cookie "Strict" não
//   viaja junto). Só o callback (quando vem com ?code=) é liberado; iniciar
//   o login (sem ?code=) continua exigindo estar logado no painel.
//
// A senha (PANEL_PASSWORD) e a chave de assinatura (SESSION_SECRET) ficam
// SÓ nas Environment Variables da Vercel — nunca aparecem neste arquivo.

const STRICT_PUBLIC_PATHS = ['/login.html', '/api/auth/session', '/api/webhooks/mercadolivre'];

export const config = {
  matcher: '/:path*',
};

function isPublicPath(url) {
  if (STRICT_PUBLIC_PATHS.includes(url.pathname)) return true;
  // Só libera o callback de verdade (precisa do "code" que o Mercado Livre gera) —
  // iniciar o login do zero continua exigindo sessão válida no painel.
  if (url.pathname === '/api/auth/mercadolivre' && url.searchParams.has('code')) return true;
  return false;
}

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

  if (isPublicPath(url)) {
    return;
  }

  const token = getCookie(request, 'radar_session');
  const valid = await isValidSession(token, process.env.SESSION_SECRET);

  if (valid) {
    return;
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
