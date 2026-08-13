export interface Lead {
  id: string
  status_id: string
  status_label?: string
  display_name?: string
  contacts: Array<{
    id: string
    name?: string
    phones: Array<{ phone: string; type: string }>
  }>
  custom: Record<string, string | number | null>
  notes?: string
}

export interface CrmTask {
  lead_id: string
  text: string
  due_date: string   // "YYYY-MM-DD"
  due_time?: string  // "HH:MM:SS" optional
  is_complete: boolean
  type: 'lead'
}

export interface LeadUpdate {
  statusLabel?: string
  custom?: Record<string, string | number | null>  // logical field name → value
}

export interface CrmAdapter {
  getLeadById(leadId: string): Promise<Lead>
  getLeadByPhone(phone: string): Promise<Lead | null>
  getLeadByCompanyId(companyId: string): Promise<Lead | null>
  updateLead(leadId: string, update: LeadUpdate): Promise<void>
  createTask(task: CrmTask): Promise<void>
  createNote(leadId: string, text: string): Promise<void>
  createLead(data: { name: string; phone: string }): Promise<Lead>
  getDialableLeads(maxRetries: number, minHoursBetween: number): Promise<Lead[]>
}
