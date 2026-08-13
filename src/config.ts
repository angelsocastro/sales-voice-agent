import { z } from 'zod'

const schema = z.object({
  PORT: z.string().default('3000'),
  ATTIO_API_KEY: z.string().min(1),
  TELNYX_API_KEY: z.string().min(1),
  TELNYX_FROM_NUMBER: z.string().min(1),
  TELNYX_PUBLIC_KEY: z.string().min(1).optional(),
  // El dialer llama vía LiveKit (SIP trunk outbound + dispatch del agente),
  // no vía la API de AI Assistant de Telnyx — ver dial-script.ts.
  LIVEKIT_URL: z.string().min(1),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  LIVEKIT_SIP_OUTBOUND_TRUNK_ID: z.string().min(1),
  LIVEKIT_AGENT_NAME: z.string().default('outbound-agent'),
})

const result = schema.safeParse(process.env)

if (!result.success) {
  console.error('Missing or invalid environment variables:')
  console.error(result.error.flatten().fieldErrors)
  process.exit(1)
}

export const config = result.data
