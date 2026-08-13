import type { CrmAdapter, Lead, CrmTask, LeadUpdate } from './adapter.js'

const BASE = 'https://api.attio.com/v2'
// The dialing target is the company switchboard, not a specific person —
// Company is the anchor record for status/call_attempts/phone. People are
// optional contacts linked to a company, used only for "ask for X" context.
const OBJECT = 'companies'

const STATUS_OPTIONS = [
  'Potential',
  'Called',
  'Interested',
  'Not Interested',
  'Bad Fit',
  'Customer',
  'Canceled',
] as const

type StatusLabel = typeof STATUS_OPTIONS[number]

const MANAGED_BY_OPTIONS = ['ai', 'closer'] as const

interface AttioRecord {
  id: { record_id: string; object_id: string; workspace_id: string }
  values: Record<string, Array<Record<string, unknown>>>
}

interface Location {
  line_1: string | null
  line_2: string | null
  line_3: string | null
  line_4: string | null
  locality: string | null
  region: string | null
  postcode: string | null
  country_code: string | null
  latitude: string | null
  longitude: string | null
}

class AttioAdapter implements CrmAdapter {
  private headers: Record<string, string>

  constructor(apiKey: string) {
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
  }

  async init(): Promise<void> {
    await this.ensureAttribute('status', 'select', STATUS_OPTIONS)
    await this.ensureAttribute('call_attempts', 'number')
    await this.ensureAttribute('next_attempt', 'timestamp')
    await this.ensureAttribute('managed_by', 'select', MANAGED_BY_OPTIONS)
    await this.ensureAttribute('too_big', 'checkbox')
    await this.ensureAttribute('phone_numbers', 'phone-number')
  }

  private async ensureAttribute(
    slug: string,
    type: 'select' | 'number' | 'timestamp' | 'checkbox' | 'phone-number',
    options?: readonly string[]
  ): Promise<void> {
    const existing = await this.get<{ data: Array<{ api_slug: string }> }>(
      `/objects/${OBJECT}/attributes`
    )
    if (!existing.data.some(a => a.api_slug === slug)) {
      const body = {
        data: {
          title: slug,
          api_slug: slug,
          description: '',
          type,
          is_required: false,
          is_unique: false,
          is_multiselect: false,
          config: {},
        },
      }
      // Attribute creation can 409 if another process created it concurrently — non-fatal.
      const res = await fetch(`${BASE}/objects/${OBJECT}/attributes`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
      })
      if (!res.ok && res.status !== 409) {
        console.error(`Attio: failed to create attribute '${slug}': ${res.status} ${await res.text()}`)
        return
      }
    }

    // Select options are created via a separate endpoint, one at a time —
    // safe to re-run since a duplicate title 409s and is ignored.
    for (const title of options ?? []) {
      const res = await fetch(`${BASE}/objects/${OBJECT}/attributes/${slug}/options`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ data: { title } }),
      })
      if (!res.ok && res.status !== 409) {
        console.error(`Attio: failed to create option '${title}' on '${slug}': ${res.status} ${await res.text()}`)
      }
    }
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { headers: this.headers })
    if (!res.ok) throw new Error(`Attio GET ${path} failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<T>
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Attio POST ${path} failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<T>
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method: 'PATCH',
      headers: this.headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Attio PATCH ${path} failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<T>
  }

  // Best-effort: the primary contact linked to a company, for "ask for X" context.
  // Not authoritative for anything — a company can have zero contacts.
  private async findContact(companyId: string): Promise<{ name: string; jobTitle: string | null } | null> {
    const res = await this.post<{ data: AttioRecord[] }>(
      '/objects/people/records/query',
      { filter: { company: { target_record_id: { $eq: companyId } } }, limit: 1 }
    )
    const person = res.data[0]
    if (!person) return null
    return {
      name: (person.values.name?.[0]?.full_name as string) ?? '',
      jobTitle: (person.values.job_title?.[0]?.value as string) ?? null,
    }
  }

  private recordToLead(record: AttioRecord, notes = '', contact?: { name: string; jobTitle: string | null } | null): Lead {
    const v = record.values
    const companyName = (v.name?.[0]?.value as string) ?? ''
    const phones = (v.phone_numbers ?? []).map(p => ({
      phone: p.original_phone_number as string,
      type: 'mobile',
    }))
    const statusLabel = (v.status?.[0]?.option as { title?: string } | string | undefined)
    const status = typeof statusLabel === 'string' ? statusLabel : statusLabel?.title

    const location = v.primary_location?.[0] as unknown as Location | undefined

    const custom: Record<string, string | number | null> = {
      call_attempts: (v.call_attempts?.[0]?.value as number) ?? 0,
      next_attempt: (v.next_attempt?.[0]?.value as string) ?? null,
      managed_by: this.optionValue(v.managed_by),
      too_big: (v.too_big?.[0]?.value as boolean) ? 1 : 0,
      position: contact?.jobTitle ?? null,
      address: location?.line_1 ?? null,
      postal_code: location?.postcode ?? null,
      municipality: location?.locality ?? null,
      province: location?.region ?? null,
    }

    return {
      id: record.id.record_id,
      status_id: status ?? '',
      status_label: status,
      display_name: companyName,
      contacts: [{ id: record.id.record_id, name: contact?.name ?? '', phones }],
      custom,
      notes,
    }
  }

  private optionValue(attr: Array<Record<string, unknown>> | undefined): string | null {
    const raw = attr?.[0]?.option as { title?: string } | string | undefined
    if (!raw) return null
    return typeof raw === 'string' ? raw : raw.title ?? null
  }

  async getLeadById(leadId: string): Promise<Lead> {
    const [res, notesRes, contact] = await Promise.all([
      this.get<{ data: AttioRecord }>(`/objects/${OBJECT}/records/${leadId}`),
      this.get<{ data: Array<{ content_plaintext?: string }> }>(
        `/notes?parent_object=${OBJECT}&parent_record_id=${leadId}&limit=1&sort=-created_at`
      ),
      this.findContact(leadId),
    ])
    const noteText = notesRes.data[0]?.content_plaintext ?? ''
    return this.recordToLead(res.data, noteText, contact)
  }

  async getLeadByPhone(phone: string): Promise<Lead | null> {
    const normalized = phone.replace(/\s+/g, '')
    const res = await this.post<{ data: AttioRecord[] }>(
      `/objects/${OBJECT}/records/query`,
      { filter: { phone_numbers: { $eq: normalized } }, limit: 1 }
    )
    const record = res.data[0]
    if (!record) return null
    const contact = await this.findContact(record.id.record_id)
    return this.recordToLead(record, '', contact)
  }

  // Company IS the lead now — kept as a thin alias so callers with a Company
  // id (e.g. pasted from an app.attio.com/.../company/... URL) keep working.
  async getLeadByCompanyId(companyId: string): Promise<Lead | null> {
    try {
      return await this.getLeadById(companyId)
    } catch {
      return null
    }
  }

  async updateLead(leadId: string, update: LeadUpdate): Promise<void> {
    const values: Record<string, unknown> = {}

    if (update.statusLabel) {
      if (!STATUS_OPTIONS.includes(update.statusLabel as StatusLabel)) {
        throw new Error(`Unknown status label: ${update.statusLabel}`)
      }
      values.status = update.statusLabel
    }

    if (update.custom) {
      for (const [name, value] of Object.entries(update.custom)) {
        if (name === 'address' || name === 'postal_code' || name === 'municipality' || name === 'province') {
          // Attio requires every field of the location object on write, even
          // ones we don't use — merge with whatever this batch already set.
          const loc: Location = (values.primary_location as Location) ?? {
            line_1: null, line_2: null, line_3: null, line_4: null,
            locality: null, region: null, postcode: null, country_code: 'ES',
            latitude: null, longitude: null,
          }
          if (name === 'address') loc.line_1 = value as string | null
          if (name === 'postal_code') loc.postcode = value as string | null
          if (name === 'municipality') loc.locality = value as string | null
          if (name === 'province') loc.region = value as string | null
          values.primary_location = loc
        } else if (name === 'too_big') {
          values.too_big = Boolean(value)
        } else if (name === 'position') {
          // Person-only concept (job title of the contact) — no Company equivalent.
          continue
        } else {
          values[name] = value
        }
      }
    }

    if (Object.keys(values).length > 0) {
      await this.patch(`/objects/${OBJECT}/records/${leadId}`, { data: { values } })
    }
  }

  async createTask(task: CrmTask): Promise<void> {
    const deadline = task.due_time
      ? `${task.due_date}T${task.due_time}`
      : `${task.due_date}T00:00:00`
    await this.post('/tasks', {
      data: {
        content: task.text,
        deadline_at: deadline,
        is_completed: task.is_complete,
        linked_records: [{ target_object: OBJECT, target_record_id: task.lead_id }],
      },
    })
  }

  async createNote(leadId: string, text: string): Promise<void> {
    await this.post('/notes', {
      data: {
        parent_object: OBJECT,
        parent_record_id: leadId,
        title: 'Nota',
        format: 'plaintext',
        content: text,
      },
    })
  }

  async createLead(data: { name: string; phone: string }): Promise<Lead> {
    const res = await this.post<{ data: AttioRecord }>(`/objects/${OBJECT}/records`, {
      data: {
        values: {
          name: data.name,
          phone_numbers: [{ original_phone_number: data.phone, country_code: 'ES' }],
        },
      },
    })
    return this.recordToLead(res.data)
  }

  async getDialableLeads(maxRetries: number, _minHoursBetween: number): Promise<Lead[]> {
    // Attio's select attributes only support $eq in record queries, not $in —
    // so status filtering happens client-side, same as the rest of the logic below.
    // Fine at this volume (hundreds of leads, not millions).
    // No per-record contact lookup here — contact name isn't used for dialing,
    // only for notes/greeting context fetched lazily via getLeadById.
    const res = await this.post<{ data: AttioRecord[] }>(
      `/objects/${OBJECT}/records/query`,
      { limit: 500 }
    )

    const now = new Date()
    const DIALABLE_STATUSES: readonly string[] = ['Potential', 'Called']
    // minHoursBetween enforcement is handled via the next_attempt custom field,
    // which schedule_callback always writes when rescheduling a lead.
    return res.data
      .map(record => this.recordToLead(record))
      .filter(lead => {
        if (!lead.status_label || !DIALABLE_STATUSES.includes(lead.status_label)) return false
        if (lead.custom.too_big) return false

        const attempts = (lead.custom.call_attempts as number) ?? 0
        if (attempts >= maxRetries) return false

        const nextAttempt = lead.custom.next_attempt as string | null
        if (nextAttempt && new Date(nextAttempt).getTime() > now.getTime()) return false

        if (lead.custom.managed_by === 'closer') return false

        return true
      })
  }
}

export async function createAttioAdapter(apiKey: string): Promise<CrmAdapter> {
  const adapter = new AttioAdapter(apiKey)
  await adapter.init()
  return adapter
}
