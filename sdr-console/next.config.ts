import type { NextConfig } from 'next'
import path from 'node:path'

// sdr-console es un paquete standalone con su propio lockfile (mismo patrón
// que livekit-agent) dentro de un monorepo sin workspaces — sin esto, Next
// infiere mal la raíz por el package-lock.json del repo padre.
// turbopack.root cubre lo mismo para `next dev` (Turbopack por defecto desde
// 15.5): sin él, Turbopack sube al lockfile del repo padre y falla con
// "couldn't find the Next.js package" al no encontrar next/package.json
// relativo a ese directorio equivocado.
const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(__dirname),
  turbopack: {
    root: path.resolve(__dirname),
  },
  // src/ del repo raíz usa imports relativos con sufijo .js apuntando a
  // archivos .ts (convención NodeNext/tsx del resto del repo — ver
  // dial-script.ts: import '../crm/attio.js'). El resolver por defecto de
  // webpack no lo entiende fuera del árbol propio del proyecto; esto le
  // enseña a tratar ".js" como alias de ".ts" también — así app/api/dial y
  // app/api/queue pueden importar src/crm/attio.ts y
  // src/dialer/dial-script.ts directamente, sin duplicar esa lógica aquí.
  webpack: config => {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}

export default nextConfig
