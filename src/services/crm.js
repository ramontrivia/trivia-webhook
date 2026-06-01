// ============================================================
// src/services/crm.js
// TRIVIA TECNOLOGIA — CRM + Funil de Vendas
// Node.js ESM
// ============================================================

import { supabase } from './supabase.js';

// ============================================================
// ETAPAS VÁLIDAS DO FUNIL
// ============================================================

export const STAGES = {
  NOVO_LEAD:    'novo_lead',
  QUALIFICADO:  'qualificado',
  ESPECIALISTA: 'especialista',
  NEGOCIANDO:   'negociando',
  IMPLANTACAO:  'implantacao',
  CLIENTE_ATIVO:'cliente_ativo',
  PERDIDO:      'perdido',
  EM_ATENDIMENTO: 'em_atendimento',
};

// ============================================================
// MAPEAMENTO STAGE → LEAD_PHASE
// Toda vez que o stage muda, a fase da MEL muda junto.
// Assim o comportamento da MEL é sempre consistente com o funil.
// ============================================================

const STAGE_TO_PHASE = {
  novo_lead:    'frio',
  perdido:      'frio',
  qualificado:  'morno',
  especialista: 'quente',
  negociando:   'quente',
  implantacao:  'quente',
  cliente_ativo:'quente',
};

function stageToPhase(stage) {
  return STAGE_TO_PHASE[stage] || 'frio';
}

// ============================================================
// BUSCAR OU CRIAR LEAD PELO TELEFONE
// Chamado pelo orchestrator quando chega mensagem nova
// ============================================================

export async function getOrCreateLead(phone, companyId) {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('leads')
      .select('*')
      .eq('phone', phone)
      .eq('company_id', companyId)
      .single();

    if (fetchError && fetchError.code !== 'PGRST116') {
      console.error('[CRM] Erro ao buscar lead:', fetchError.message);
      return null;
    }

    if (existing) {
      // Atualiza último contato e última mensagem recebida
      await supabase
        .from('leads')
        .update({
          last_contact_at: new Date().toISOString(),
          last_inbound_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
      return existing;
    }

    // Cria novo lead — entra como frio por padrão
    const { data: newLead, error: createError } = await supabase
      .from('leads')
      .insert({
        phone,
        company_id:      companyId,
        stage:           STAGES.NOVO_LEAD,
        lead_phase:      'frio',
        lead_score:      0,
        source:          'whatsapp',
        last_inbound_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (createError) {
      console.error('[CRM] Erro ao criar lead:', createError.message);
      return null;
    }

    console.log(`[CRM] Novo lead criado: ${phone} | fase: frio`);
    return newLead;

  } catch (err) {
    console.error('[CRM] Erro inesperado em getOrCreateLead:', err.message);
    return null;
  }
}

// ============================================================
// ATUALIZAR DADOS DO LEAD
// ============================================================

export async function updateLead(leadId, data) {
  try {
    const { error } = await supabase
      .from('leads')
      .update({
        ...data,
        last_contact_at: new Date().toISOString(),
      })
      .eq('id', leadId);

    if (error) {
      console.error('[CRM] Erro ao atualizar lead:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('[CRM] Erro inesperado em updateLead:', err.message);
    return false;
  }
}

// ============================================================
// AVANÇAR ETAPA DO FUNIL
// Atualiza stage E lead_phase juntos — sempre sincronizados.
// ============================================================

export async function advanceStage(leadId, newStage, changedBy = 'mel', note = null) {
  try {
    const { data: lead } = await supabase
      .from('leads')
      .select('stage, lead_phase, name, phone, business_name')
      .eq('id', leadId)
      .single();

    if (!lead) return false;
    if (lead.stage === newStage) return true;

    // ── Calcula nova fase com base no novo stage ──────────────
    const newPhase = stageToPhase(newStage);
    const phaseChanged = lead.lead_phase !== newPhase;

    // ── Atualiza stage + lead_phase juntos ────────────────────
    const { error } = await supabase
      .from('leads')
      .update({
        stage:            newStage,
        lead_phase:       newPhase,
        phase_updated_at: new Date().toISOString(),
      })
      .eq('id', leadId);

    if (error) {
      console.error('[CRM] Erro ao avançar etapa:', error.message);
      return false;
    }

    // Registra mudança de stage
    await registerInteraction(leadId, 'stage_change',
      `${lead.stage} → ${newStage}`, changedBy);

    // Registra mudança de fase se mudou
    if (phaseChanged) {
      await registerInteraction(leadId, 'phase_change',
        `${lead.lead_phase} → ${newPhase}`, changedBy);
      console.log(`[CRM] Lead ${lead.phone} | fase: ${lead.lead_phase} → ${newPhase}`);
    }

    // Dispara notificação se necessário
    await checkAndNotify(leadId, lead, newStage, note);

    console.log(`[CRM] Lead ${lead.phone} | stage: ${lead.stage} → ${newStage}`);
    return true;

  } catch (err) {
    console.error('[CRM] Erro inesperado em advanceStage:', err.message);
    return false;
  }
}

// ============================================================
// REGISTRAR INTERAÇÃO
// ============================================================

export async function registerInteraction(leadId, type, summary, createdBy = 'mel') {
  try {
    await supabase
      .from('lead_interactions')
      .insert({ lead_id: leadId, type, summary, created_by: createdBy });
  } catch (err) {
    console.error('[CRM] Erro ao registrar interação:', err.message);
  }
}

// ============================================================
// QUALIFICAR LEAD AUTOMATICAMENTE
// ============================================================

export async function qualifyLead(leadId, qualificationData) {
  const {
    name,
    businessName,
    businessType,
    city,
    painDescription,
    interestedModules = [],
  } = qualificationData;

  try {
    await updateLead(leadId, {
      name,
      business_name:     businessName,
      business_type:     businessType,
      city,
      pain_description:  painDescription,
      interested_modules:interestedModules,
    });

    await advanceStage(leadId, STAGES.QUALIFICADO, 'mel',
      `Qualificado pela Mel. Dor: ${painDescription}`);

    return true;
  } catch (err) {
    console.error('[CRM] Erro em qualifyLead:', err.message);
    return false;
  }
}

// ============================================================
// NOTIFICAR RAMON
// ============================================================

async function checkAndNotify(leadId, lead, newStage, note) {
  const notifyOnStages = {
    [STAGES.QUALIFICADO]: {
      type:    'lead_qualificado',
      message: `🔥 Lead qualificado!\n${lead.name || lead.phone} — ${lead.business_name || 'Negócio não informado'}\nDor identificada. Pronto pra você agir.`,
    },
    [STAGES.ESPECIALISTA]: {
      type:    'especialista_acionado',
      message: `📞 Especialista acionado!\n${lead.name || lead.phone} quer falar com você.\nContato: ${lead.phone}`,
    },
    [STAGES.CLIENTE_ATIVO]: {
      type:    'cliente_novo',
      message: `🎉 Novo cliente ativo!\n${lead.business_name || lead.name || lead.phone} está no ar.`,
    },
  };

  const notif = notifyOnStages[newStage];
  if (!notif) return;

  await supabase
    .from('crm_notifications')
    .insert({
      lead_id: leadId,
      type:    notif.type,
      message: note ? `${notif.message}\n\nObs: ${note}` : notif.message,
    });
}

// ============================================================
// BUSCAR NOTIFICAÇÕES NÃO LIDAS
// ============================================================

export async function getUnreadNotifications() {
  const { data, error } = await supabase
    .from('crm_notifications')
    .select(`*, leads (name, phone, business_name, stage)`)
    .eq('read', false)
    .order('sent_at', { ascending: false });

  if (error) {
    console.error('[CRM] Erro ao buscar notificações:', error.message);
    return [];
  }

  return data || [];
}

// ============================================================
// MARCAR NOTIFICAÇÕES COMO LIDAS
// ============================================================

export async function markNotificationsRead(ids = []) {
  if (!ids.length) return;
  await supabase
    .from('crm_notifications')
    .update({ read: true })
    .in('id', ids);
}

// ============================================================
// BUSCAR LEADS QUENTES
// ============================================================

export async function getHotLeads() {
  const { data, error } = await supabase
    .from('hot_leads')
    .select('*');

  if (error) {
    console.error('[CRM] Erro ao buscar hot leads:', error.message);
    return [];
  }

  return data || [];
}

// ============================================================
// VISÃO GERAL DO FUNIL
// ============================================================

export async function getFunnelOverview() {
  const { data, error } = await supabase
    .from('funnel_overview')
    .select('*');

  if (error) {
    console.error('[CRM] Erro ao buscar funil:', error.message);
    return [];
  }

  return data || [];
}

// ============================================================
// MARCAR COMO PERDIDO
// ============================================================

export async function markAsLost(leadId, reason) {
  await updateLead(leadId, { lost_reason: reason });
  await advanceStage(leadId, STAGES.PERDIDO, 'ramon', reason);
}

// ============================================================
// DETECÇÃO AUTOMÁTICA DE INTENÇÃO NA MENSAGEM
// ============================================================

export function detectIntention(message) {
  const msg = message.toLowerCase();

  const intentions = {
    agendamento:  ['agenda', 'agendar', 'horário', 'marcar', 'reservar'],
    crm:          ['funil', 'lead', 'crm', 'vendas', 'pipeline', 'fechar'],
    n8n:          ['automação', 'automático', 'follow', 'lembrete', 'notificação'],
    disparos:     ['disparo', 'campanha', 'promoção', 'mandar pra base', 'marketing'],
    relatorios:   ['relatório', 'métrica', 'dado', 'desempenho', 'resultado'],
    preco:        ['quanto', 'preço', 'valor', 'custo', 'plano'],
    especialista: ['quero contratar', 'quero saber mais', 'falar com', 'especialista',
                   'pode passar', 'como contrato', 'quero sim', 'quero começar'],
  };

  const detected = [];

  for (const [key, keywords] of Object.entries(intentions)) {
    if (keywords.some(k => msg.includes(k))) {
      detected.push(key);
    }
  }

  return detected;
}

// ============================================================
// PROCESSAR MENSAGEM E ATUALIZAR CRM AUTOMATICAMENTE
// Integração principal com o orchestrator
// ============================================================

export async function processCrmFromMessage(lead, message) {
  if (!lead) return;

  const intentions = detectIntention(message);
  if (!intentions.length) return;

  const moduleIntentions = intentions.filter(i =>
    !['preco', 'especialista'].includes(i)
  );

  if (moduleIntentions.length) {
    const current = lead.interested_modules || [];
    const merged  = [...new Set([...current, ...moduleIntentions])];
    await updateLead(lead.id, { interested_modules: merged });
  }

  // ── Lead quer especialista → avança direto, qualquer stage ──
  // Não exige mais passar por 'qualificado' antes.
  // Se sinalizou intenção de contratar, vai direto pra quente.
  const stagesFinais = [
    STAGES.ESPECIALISTA,
    STAGES.NEGOCIANDO,
    STAGES.IMPLANTACAO,
    STAGES.CLIENTE_ATIVO,
    STAGES.PERDIDO,
  ];

  if (intentions.includes('especialista') && !stagesFinais.includes(lead.stage)) {
    await advanceStage(
      lead.id,
      STAGES.ESPECIALISTA,
      'mel',
      'Lead sinalizou intenção de contratar'
    );
    return; // já avançou pro máximo, não processa mais
  }

  // Lead novo com intenção clara → qualifica e vai pra morno
  if (lead.stage === STAGES.NOVO_LEAD && moduleIntentions.length > 0) {
    await advanceStage(lead.id, STAGES.QUALIFICADO, 'mel',
      `Intenção detectada: ${moduleIntentions.join(', ')}`);
  }
}
