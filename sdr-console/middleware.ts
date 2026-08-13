import { NextRequest, NextResponse } from 'next/server'

// Basic auth mínima: un solo password compartido via env var. Alcanza para
// un operador — si esto crece a varios usuarios, migrar a un proveedor real
// (Clerk/NextAuth) en vez de sumar más lógica acá.
export function middleware(request: NextRequest) {
  const password = process.env.SDR_CONSOLE_PASSWORD
  if (!password) {
    // Sin password configurado, no hay forma segura de dejar pasar ni de
    // bloquear con criterio — mejor romper explícito que servir la
    // dashboard abierta a cualquiera por un env var faltante en deploy.
    return new NextResponse('SDR_CONSOLE_PASSWORD no configurada', { status: 500 })
  }

  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Basic ')) {
    const decoded = atob(authHeader.slice('Basic '.length))
    const [, suppliedPassword] = decoded.split(':')
    if (suppliedPassword === password) {
      return NextResponse.next()
    }
  }

  return new NextResponse('Auth requerida', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="sdr-console"' },
  })
}

export const config = {
  matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
}
