// Server-side gate for the admin dashboard. Without a valid admin session cookie, requests for the
// admin page or its script never reach the files: the page redirects to the wallet sign-in, and the
// script gets a 401. Sessions are issued by api/admin/login.js.
import { next } from '@vercel/functions';
import session from './lib/admin-session.js';

export const config = {
  matcher: ['/admin', '/admin.html', '/admin.js'],
};

export default function middleware(request) {
  const token = session.readCookie(request.headers.get('cookie'));
  if (session.verify(token)) {
    return next({ headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
  }
  const url = new URL(request.url);
  if (url.pathname.endsWith('.js')) {
    return new Response('Admin sign-in required', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  return Response.redirect(new URL('/admin-login.html', request.url), 302);
}
