import type { CrmAdapter, Lead } from '../crm/adapter.js'

export interface InsightResult {
  call_outcome: string | null
  call_summary: string | null
}

export interface InsightsPayload {
  record_type: string
  event_type: string
  payload: {
    conversation_id: string
    insight_group_id?: string
    results: Array<{
      result: string | Record<string, unknown>
      insight_id: string
    }>
    metadata: {
      to?: string
      from?: string
      lead_id?: string
      [key: string]: unknown
    }
  }
}

const TERMINAL_STATUSES = new Set(['Customer', 'Canceled', 'Bad Fit', 'Not Interested'])

const OUTCOME_TO_STATUS: Record<string, string> = {
  called: 'Called',
  interested: 'Interested',
  bad_fit: 'Bad Fit',
  not_interested: 'Not Interested',
}

export async function reconcileInsights(payload: InsightsPayload, adapter: CrmAdapter): Promise<void> {
  const meta = payload.payload.metadata
  const results = payload.payload.results

  // Resolve lead_id: prefer conversation_metadata injection, fallback to phone lookup
  let leadId = meta.lead_id ?? null
  let lead: Lead | null = null

  if (leadId) {
    try { lead = await adapter.getLeadById(leadId) } catch { lead = null }
  }

  const endUserPhone = (meta.telnyx_end_user_target as string | undefined) ?? meta.from
  if (!lead && endUserPhone) {
    lead = await adapter.getLeadByPhone(endUserPhone)
    if (lead) {
      leadId = lead.id
      console.error(`[reconcile] lead resolved via phone ${endUserPhone} → ${leadId}`)
    }
  }

  if (!lead || !leadId) {
    console.error(`[reconcile] lead not found — metadata.lead_id=${meta.lead_id ?? 'none'} end_user_phone=${endUserPhone ?? 'none'}`)
    return
  }
  console.error(`[reconcile] processing lead ${leadId} (${lead.display_name ?? 'unknown'}) status=${lead.status_label ?? 'none'}`)

  // Parse insight result — Telnyx may return structured data as JSON string or parsed object
  const insightData: InsightResult = { call_outcome: null, call_summary: null }
  for (const r of results) {
    let obj: Record<string, unknown> | null = null
    if (typeof r.result === 'object' && r.result !== null) {
      obj = r.result as Record<string, unknown>
    } else if (typeof r.result === 'string') {
      try { obj = JSON.parse(r.result) } catch { /* unstructured */ }
    }

    if (obj && ('call_outcome' in obj || 'call_summary' in obj)) {
      insightData.call_outcome = (obj.call_outcome as string) ?? null
      insightData.call_summary = (obj.call_summary as string) ?? null
    } else if (typeof r.result === 'string' && !insightData.call_summary) {
      insightData.call_summary = r.result
    }
  }

  const isTerminal = lead.status_label != null && TERMINAL_STATUSES.has(lead.status_label)

  if (insightData.call_outcome && !isTerminal) {
    const statusLabel = OUTCOME_TO_STATUS[insightData.call_outcome]
    if (statusLabel) {
      console.error(`[reconcile] updating lead ${leadId} status → ${statusLabel}`)
      await adapter.updateLead(leadId, { statusLabel })
    } else {
      console.error(`[reconcile] unknown call_outcome="${insightData.call_outcome}" — no status update`)
    }
  } else if (isTerminal) {
    console.error(`[reconcile] lead ${leadId} is terminal (${lead.status_label}) — skipping status update`)
  }

  if (insightData.call_summary) {
    console.error(`[reconcile] creating note for lead ${leadId}`)
    await adapter.createNote(leadId, insightData.call_summary)
  }
}
