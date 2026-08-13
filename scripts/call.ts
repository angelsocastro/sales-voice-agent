#!/usr/bin/env npx tsx
import { createAttioAdapter } from '../src/crm/attio.js'
import { triggerOutboundCall, type DialOptions } from '../src/dialer/dial-script.js'

const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER ?? ''
const ATTIO_API_KEY = process.env.ATTIO_API_KEY ?? ''
const LIVEKIT_URL = process.env.LIVEKIT_URL ?? ''
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? ''
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? ''
const LIVEKIT_SIP_OUTBOUND_TRUNK_ID = process.env.LIVEKIT_SIP_OUTBOUND_TRUNK_ID ?? ''
const LIVEKIT_AGENT_NAME = process.env.LIVEKIT_AGENT_NAME ?? 'outbound-agent'

if (!ATTIO_API_KEY || !LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_SIP_OUTBOUND_TRUNK_ID) {
  console.error(
    'Missing ATTIO_API_KEY / LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_SIP_OUTBOUND_TRUNK_ID',
  )
  process.exit(1)
}

const adapter = await createAttioAdapter(ATTIO_API_KEY)

const cliArgs = process.argv.slice(2).filter(a => a !== '--')

const opts: DialOptions = {
  livekitUrl: LIVEKIT_URL,
  livekitApiKey: LIVEKIT_API_KEY,
  livekitApiSecret: LIVEKIT_API_SECRET,
  sipOutboundTrunkId: LIVEKIT_SIP_OUTBOUND_TRUNK_ID,
  agentName: LIVEKIT_AGENT_NAME,
  fromNumber: TELNYX_FROM_NUMBER,
}

if (cliArgs[0] === '--batch') {
  const n = parseInt(cliArgs[1] ?? '10', 10)
  const leads = await adapter.getDialableLeads(3, 3)
  const batch = leads.slice(0, n)
  console.error(`Launching ${batch.length} calls...`)
  for (const lead of batch) {
    await triggerOutboundCall(lead, opts)
    console.error(`Called: ${lead.display_name ?? lead.id}`)
  }
} else if (cliArgs[0]) {
  const target = cliArgs[0]
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)
  let lead
  if (isUuid) {
    lead = await adapter.getLeadById(target)
  } else {
    lead = await adapter.getLeadByPhone(target)
  }
  if (!lead) { console.error('Lead not found'); process.exit(1) }
  await triggerOutboundCall(lead, opts)
  console.error(`Called: ${lead.display_name ?? lead.id}`)
} else {
  console.error('Usage: npx tsx scripts/call.ts <lead_id|phone> | --batch <N>')
  process.exit(1)
}
