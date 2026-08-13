import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Copiloto SDR',
  description: 'Dashboard del Modelo B: el operador habla, el copiloto sugiere.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <main>{children}</main>
      </body>
    </html>
  )
}
